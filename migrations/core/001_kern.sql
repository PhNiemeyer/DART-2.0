-- DART 2.0 – Forschungskern (pseudonym). Keine Klarnamen, keine Kontaktdaten, keine Signaturen.
-- Ausgeführt als dart_owner. Laufzeitrollen: dart_app (API), dart_worker (Worker), dart_migration (Migration).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen für RLS: Zentrumsliste aus der Transaktionsvariable app.center_ids
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dart_center_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.center_ids', true), '')::uuid[], ARRAY[]::uuid[])
$$;

CREATE OR REPLACE FUNCTION dart_patient_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.patient_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Zentren, Nutzer, Rollen
-- ---------------------------------------------------------------------------
CREATE TABLE center (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE center_science_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  valid_from date NOT NULL,
  valid_to date,
  approved_by text NOT NULL,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  external_subject text UNIQUE,
  active boolean NOT NULL DEFAULT true,
  locked_reason text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_center_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  center_id uuid REFERENCES center(id),
  role text NOT NULL CHECK (role IN ('zentrale_admin','zentrumsverantwortlich','arzt','dokumentation','datenmanagement','formularredaktion','formularfreigabe','forschung','technik')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  granted_by uuid REFERENCES app_user(id),
  UNIQUE (user_id, center_id, role)
);

-- ---------------------------------------------------------------------------
-- Patienten und Behandlungsfälle (pseudonym)
-- ---------------------------------------------------------------------------
CREATE TABLE patient (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  pseudonym text NOT NULL UNIQUE,
  vault_ref uuid NOT NULL UNIQUE,
  synthetic boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id)
);

CREATE SEQUENCE case_no_seq START 1001;

CREATE TABLE treatment_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no text NOT NULL UNIQUE DEFAULT ('D-' || nextval('case_no_seq')),
  center_id uuid NOT NULL REFERENCES center(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  joint text NOT NULL CHECK (joint IN ('knie','schulter','huefte','sprunggelenk')),
  side text NOT NULL CHECK (side IN ('links','rechts')),
  treatment_type text NOT NULL CHECK (treatment_type IN ('operativ','konservativ')),
  surgeon_user_id uuid REFERENCES app_user(id),
  planned_op_date date,
  actual_op_date date,
  conservative_start_date date,
  status text NOT NULL DEFAULT 'consent_ausstehend' CHECK (status IN ('consent_ausstehend','aktiv','abgeschlossen','gesperrt')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),
  CHECK (treatment_type <> 'konservativ' OR conservative_start_date IS NOT NULL),
  CHECK (treatment_type <> 'operativ' OR planned_op_date IS NOT NULL OR actual_op_date IS NOT NULL)
);
CREATE INDEX ON treatment_case (center_id, created_at DESC);
CREATE INDEX ON treatment_case (patient_id);

-- Patient und Fall müssen zum selben Zentrum gehören (keine zentrumsübergreifende Verschmelzung)
CREATE OR REPLACE FUNCTION trg_case_same_center() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT center_id FROM patient WHERE id = NEW.patient_id) IS DISTINCT FROM NEW.center_id THEN
    RAISE EXCEPTION 'Fall und Patient müssen demselben Zentrum angehören' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_same_center BEFORE INSERT OR UPDATE OF center_id, patient_id ON treatment_case
  FOR EACH ROW EXECUTE FUNCTION trg_case_same_center();

CREATE TABLE case_register_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  center_id uuid NOT NULL REFERENCES center(id),
  register_code text NOT NULL CHECK (register_code IN ('DART','KNORPEL_DGOU','DEKOR')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  UNIQUE (case_id, register_code, valid_from)
);

CREATE TABLE capture_mode_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  center_id uuid NOT NULL REFERENCES center(id),
  mode text NOT NULL CHECK (mode IN ('basic','science')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  reason text,
  changed_by uuid REFERENCES app_user(id)
);
CREATE UNIQUE INDEX capture_mode_one_open ON capture_mode_history (case_id) WHERE valid_to IS NULL;

CREATE TABLE case_module (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  center_id uuid NOT NULL REFERENCES center(id),
  module_code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES app_user(id),
  UNIQUE (case_id, module_code)
);

CREATE TABLE procedure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  center_id uuid NOT NULL REFERENCES center(id),
  concept_code text NOT NULL,
  ops_code text NOT NULL,
  ops_version text NOT NULL,
  source text NOT NULL DEFAULT 'erfassung',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Definitionen: Variablen, Formulare (versioniert, nach Veröffentlichung unveränderlich), Scores
-- FormItem, BranchRule, ValidationRule und Codelisten sind Teil des versionierten JSON-Schemas
-- (ADR-0004); variable_concept/variable_definition_version werden bei Veröffentlichung abgeleitet.
-- ---------------------------------------------------------------------------
CREATE TABLE variable_concept (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  var_id text NOT NULL UNIQUE,
  label text NOT NULL,
  classification text CHECK (classification IN ('A','B','C','D')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('arzt','patient')),
  module_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  questionnaire_id uuid NOT NULL REFERENCES questionnaire(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'entwurf' CHECK (status IN ('entwurf','in_pruefung','freigegeben','veroeffentlicht','ruhestand')),
  schema jsonb NOT NULL,
  schema_hash text,
  author_id uuid REFERENCES app_user(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES app_user(id),
  approved_at timestamptz,
  published_by uuid REFERENCES app_user(id),
  published_at timestamptz,
  valid_from date,
  valid_to date,
  change_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (questionnaire_id, version)
);
CREATE UNIQUE INDEX questionnaire_one_published ON questionnaire_version (questionnaire_id) WHERE status = 'veroeffentlicht';

CREATE OR REPLACE FUNCTION trg_qv_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('veroeffentlicht','ruhestand') THEN
    IF NEW.schema IS DISTINCT FROM OLD.schema OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.questionnaire_id IS DISTINCT FROM OLD.questionnaire_id THEN
      RAISE EXCEPTION 'Veröffentlichte Formularversionen sind unveränderlich' USING ERRCODE = '42501';
    END IF;
    IF NOT (OLD.status = 'veroeffentlicht' AND NEW.status IN ('veroeffentlicht','ruhestand')) AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Unzulässiger Statuswechsel einer veröffentlichten Version' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.status IN ('in_pruefung','freigegeben') AND NEW.schema IS DISTINCT FROM OLD.schema THEN
    RAISE EXCEPTION 'Schema in Prüfung/Freigabe kann nicht geändert werden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qv_immutable BEFORE UPDATE ON questionnaire_version FOR EACH ROW EXECUTE FUNCTION trg_qv_immutable();

CREATE OR REPLACE FUNCTION trg_no_delete_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('veroeffentlicht','ruhestand') THEN
    RAISE EXCEPTION 'Veröffentlichte Formularversionen können nicht gelöscht werden' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER qv_no_delete BEFORE DELETE ON questionnaire_version FOR EACH ROW EXECUTE FUNCTION trg_no_delete_published();

CREATE TABLE variable_definition_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES variable_concept(id),
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_version(id),
  item_id text NOT NULL,
  item_type text NOT NULL,
  label text NOT NULL,
  unit text,
  codes jsonb,
  UNIQUE (questionnaire_version_id, item_id)
);

CREATE TABLE score_algorithm_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  licensed_original boolean NOT NULL DEFAULT false,
  UNIQUE (code, version)
);

CREATE TABLE followup_plan_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  definition jsonb NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE assignment_matrix_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  valid_from date NOT NULL,
  definition jsonb NOT NULL,
  UNIQUE (code, version)
);

-- ---------------------------------------------------------------------------
-- Einwilligung (Kern hält nur Status, Umfang und Nachweisreferenz; Dokumente im Vault)
-- ---------------------------------------------------------------------------
CREATE TABLE consent_document_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  body_sha256 text NOT NULL,
  scopes text[] NOT NULL,
  is_demo boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE consent_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  document_version_id uuid REFERENCES consent_document_version(id),
  status text NOT NULL CHECK (status IN ('fehlt','vorbereitet','signatur_ausstehend','upload_in_pruefung','gueltig','abgelehnt','widerrufen','erneuerung_erforderlich','historisch_ungeklaert')),
  method text NOT NULL CHECK (method IN ('digital_demo','papier_upload','altbestand')),
  scopes text[] NOT NULL DEFAULT '{}',
  informed_by text,
  signed_date date,
  uploaded_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES app_user(id),
  review_checklist jsonb,
  rejection_reason text,
  evidence_ref uuid,
  evidence_sha256 text,
  evidence_package jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),
  -- Ein gültiger Status braucht einen Nachweis und eine Prüfung
  CHECK (status <> 'gueltig' OR (evidence_ref IS NOT NULL AND evidence_sha256 IS NOT NULL AND reviewed_at IS NOT NULL AND signed_date IS NOT NULL))
);
CREATE INDEX ON consent_record (patient_id);

CREATE TABLE withdrawal_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id uuid NOT NULL REFERENCES consent_record(id),
  center_id uuid NOT NULL REFERENCES center(id),
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL CHECK (channel IN ('portal','personal','schriftlich')),
  recorded_by uuid REFERENCES app_user(id),
  data_handling text NOT NULL DEFAULT 'offen_rechtliche_entscheidung',
  note text
);

-- ---------------------------------------------------------------------------
-- Erhebungen
-- ---------------------------------------------------------------------------
CREATE TABLE assessment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  center_id uuid NOT NULL REFERENCES center(id),
  timepoint text NOT NULL,
  plan_code text NOT NULL,
  plan_version integer NOT NULL,
  reference_kind text NOT NULL,
  due_date date,
  window_start date,
  window_end date,
  status text NOT NULL DEFAULT 'geplant' CHECK (status IN ('geplant','eingeladen','begonnen','abgeschlossen','abgebrochen','gesperrt')),
  started_at timestamptz,
  completed_at timestamptz,
  source text NOT NULL DEFAULT 'plan' CHECK (source IN ('plan','migration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, timepoint, plan_code)
);
CREATE INDEX ON assessment_event (center_id, status, due_date);

CREATE TABLE response (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  case_id uuid NOT NULL REFERENCES treatment_case(id),
  assessment_event_id uuid NOT NULL REFERENCES assessment_event(id),
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_version(id),
  module_code text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('arzt','patient')),
  status text NOT NULL DEFAULT 'entwurf' CHECK (status IN ('entwurf','abgeschlossen','wiedereroeffnet')),
  instances jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  started_at timestamptz,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_event_id, questionnaire_version_id)
);
CREATE INDEX ON response (case_id);

CREATE TABLE response_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES response(id),
  center_id uuid NOT NULL REFERENCES center(id),
  revision integer NOT NULL,
  answers jsonb NOT NULL,
  instances jsonb NOT NULL,
  inactive_keys text[] NOT NULL DEFAULT '{}',
  action text NOT NULL CHECK (action IN ('entwurf','abschluss','wiedereroeffnung','anlage')),
  reason text,
  changed_by uuid REFERENCES app_user(id),
  changed_by_patient boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, revision)
);

CREATE TABLE answer (
  response_id uuid NOT NULL REFERENCES response(id),
  center_id uuid NOT NULL REFERENCES center(id),
  answer_key text NOT NULL,
  item_id text NOT NULL,
  repeat_instance_id text NOT NULL DEFAULT '',
  value_text text,
  value_number numeric,
  value_date date,
  value_codes text[],
  missing_reason text CHECK (missing_reason IN ('nicht_erhoben','nicht_zutreffend','unbekannt','verweigert','historisch_leer')),
  active boolean NOT NULL DEFAULT true,
  updated_revision integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (response_id, answer_key),
  -- genau ein Wert ODER ein zulässiger Fehlgrund
  CHECK ((num_nonnulls(value_text, value_number, value_date, value_codes) = 1 AND missing_reason IS NULL)
      OR (num_nonnulls(value_text, value_number, value_date, value_codes) = 0 AND missing_reason IS NOT NULL))
);

CREATE TABLE derived_score (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES response(id),
  center_id uuid NOT NULL REFERENCES center(id),
  answer_key text NOT NULL,
  algorithm text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('neuberechnung','original_historisch')),
  value numeric,
  reason text,
  used_inputs integer,
  total_inputs integer,
  response_revision integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, answer_key, algorithm, kind, response_revision)
);

-- ---------------------------------------------------------------------------
-- Einladungen, Versand (Transactional Outbox)
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  case_id uuid REFERENCES treatment_case(id),
  assessment_event_id uuid REFERENCES assessment_event(id),
  purpose text NOT NULL CHECK (purpose IN ('vor_ort','befragung')),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','eingeloest','abgelaufen','widerrufen')),
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash text NOT NULL UNIQUE,
  patient_id uuid NOT NULL REFERENCES patient(id),
  center_id uuid NOT NULL REFERENCES center(id),
  invitation_id uuid NOT NULL REFERENCES invitation(id),
  verified boolean NOT NULL DEFAULT false,
  verify_attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('einladung','erinnerung','arzt_erinnerung','vor_ort_link','export')),
  center_id uuid REFERENCES center(id),
  patient_id uuid REFERENCES patient(id),
  case_id uuid REFERENCES treatment_case(id),
  assessment_event_id uuid REFERENCES assessment_event(id),
  rule_version text NOT NULL,
  stage text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ausstehend' CHECK (status IN ('ausstehend','in_versand','versendet','unklar','fehlgeschlagen','dead_letter','storniert')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  provider_message_id text,
  last_error text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbox_message (status, next_attempt_at);

CREATE TABLE delivery_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES outbox_message(id),
  attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result text NOT NULL CHECK (result IN ('versendet','fehler','unklar','storniert','abgeglichen')),
  provider_message_id text,
  error_code text,
  UNIQUE (outbox_id, attempt_no)
);

-- ---------------------------------------------------------------------------
-- Audit (append-only), Exporte, Idempotenz
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('nutzer','patient','system','worker')),
  actor_roles text[] NOT NULL DEFAULT '{}',
  center_id uuid,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  result text NOT NULL CHECK (result IN ('erfolg','abgelehnt','fehler')),
  revision integer,
  reason text,
  request_id text
);
CREATE INDEX ON audit_event (object_type, object_id);
CREATE INDEX ON audit_event (at DESC);

CREATE OR REPLACE FUNCTION trg_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Auditereignisse sind unveränderlich' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION trg_audit_append_only();

CREATE TABLE export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  purpose text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('basic','science')),
  center_ids uuid[],
  period_from date NOT NULL,
  period_to date NOT NULL,
  layers text[] NOT NULL,
  status text NOT NULL DEFAULT 'beantragt' CHECK (status IN ('beantragt','genehmigt','abgelehnt','in_arbeit','fertig','fehler')),
  decided_by uuid REFERENCES app_user(id),
  decided_at timestamptz,
  decision_note text,
  stichtag timestamptz,
  result_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE TABLE export_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_job_id uuid NOT NULL REFERENCES export_job(id),
  file_name text NOT NULL,
  content_type text NOT NULL,
  content bytea NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (export_job_id, file_name)
);

CREATE TABLE idempotency_record (
  key text NOT NULL,
  actor text NOT NULL,
  endpoint text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, key)
);

-- ---------------------------------------------------------------------------
-- Datensicherheitsrelevante Betroffenenanfragen (D03)
-- ---------------------------------------------------------------------------
CREATE TABLE data_subject_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL REFERENCES center(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  kind text NOT NULL CHECK (kind IN ('auskunft','berichtigung','einschraenkung','widerruf','loeschung')),
  status text NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','in_bearbeitung','erledigt','abgelehnt')),
  due_date date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
