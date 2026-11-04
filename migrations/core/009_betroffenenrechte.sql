-- Betroffenenrechte (R-19): Anträge auf Auskunft, Berichtigung, Einschränkung, Widerruf und Löschung mit Fristen,
-- Identitätsprüfung, Verlängerung und lückenlosem Verlauf. Bearbeitung durch das Zentrum (Entscheidung des Auftraggebers).
-- Löschung wird vorbereitet (Sperre + Übersicht je Datenklasse), nicht automatisch ausgeführt (E-07 offen).

ALTER TABLE data_subject_request ADD COLUMN case_id uuid REFERENCES treatment_case(id);
ALTER TABLE data_subject_request ADD COLUMN received_at date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE data_subject_request ADD COLUMN channel text NOT NULL DEFAULT 'schriftlich' CHECK (channel IN ('schriftlich','persoenlich','telefonisch','email','portal'));
ALTER TABLE data_subject_request ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE data_subject_request ADD COLUMN identity_method text CHECK (identity_method IN ('persoenlich_ausweis','portal_zugangscode','schriftlich_unterschrift','rueckruf_bekannte_nummer'));
ALTER TABLE data_subject_request ADD COLUMN identity_checked_by uuid REFERENCES app_user(id);
ALTER TABLE data_subject_request ADD COLUMN identity_checked_at timestamptz;
ALTER TABLE data_subject_request ADD COLUMN extended_due_date date;
ALTER TABLE data_subject_request ADD COLUMN extension_reason text CHECK (length(extension_reason) <= 500);
ALTER TABLE data_subject_request ADD COLUMN outcome text CHECK (length(outcome) <= 2000);
ALTER TABLE data_subject_request ADD COLUMN closed_by uuid REFERENCES app_user(id);
ALTER TABLE data_subject_request ADD COLUMN closed_at timestamptz;
ALTER TABLE data_subject_request ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE data_subject_request ADD CONSTRAINT dsr_note_len CHECK (length(note) <= 2000);
CREATE INDEX IF NOT EXISTS dsr_center_status_idx ON data_subject_request (center_id, status, due_date);

-- Verlauf je Antrag: nur anhängen (Akteur, Aktion, Begründung)
CREATE TABLE data_subject_request_event (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES data_subject_request(id),
  center_id uuid NOT NULL REFERENCES center(id),
  actor_user_id uuid REFERENCES app_user(id),
  action text NOT NULL,
  detail text CHECK (length(detail) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE data_subject_request_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_request_event FORCE ROW LEVEL SECURITY;
CREATE POLICY api_center ON data_subject_request_event TO dart_app USING (center_id = ANY (dart_center_ids())) WITH CHECK (center_id = ANY (dart_center_ids()));
GRANT SELECT, INSERT ON data_subject_request_event TO dart_app;
GRANT USAGE ON SEQUENCE data_subject_request_event_id_seq TO dart_app;
CREATE OR REPLACE FUNCTION dsr_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Verlauf der Betroffenenanträge ist unveränderlich'; END $$;
CREATE TRIGGER dsr_event_no_update BEFORE UPDATE OR DELETE ON data_subject_request_event FOR EACH ROW EXECUTE FUNCTION dsr_event_append_only();

-- Einschränkung der Verarbeitung (Art. 18 DSGVO): gesperrt für Exporte, Auswertungen und Versand
ALTER TABLE patient ADD COLUMN restricted_at timestamptz;
ALTER TABLE patient ADD COLUMN restricted_reason text CHECK (length(restricted_reason) <= 500);
ALTER TABLE patient ADD COLUMN restricted_request_id uuid REFERENCES data_subject_request(id);

-- Zentrale Übersicht ohne Patientenbezug: Anzahlen offen/überfällig je Zentrum und Art
CREATE OR REPLACE FUNCTION dsr_overview() RETURNS TABLE (center_code text, center_name text, kind text, offen integer, ueberfaellig integer, erledigt integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.name, d.kind,
         count(*) FILTER (WHERE d.status IN ('offen','in_bearbeitung'))::int,
         count(*) FILTER (WHERE d.status IN ('offen','in_bearbeitung') AND COALESCE(d.extended_due_date, d.due_date) < CURRENT_DATE)::int,
         count(*) FILTER (WHERE d.status IN ('erledigt','abgelehnt'))::int
    FROM data_subject_request d JOIN center c ON c.id = d.center_id
   GROUP BY c.code, c.name, d.kind ORDER BY c.code, d.kind
$$;
REVOKE ALL ON FUNCTION dsr_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsr_overview() TO dart_app;

-- Auswertungen schließen Patientinnen und Patienten mit eingeschränkter Verarbeitung aus
CREATE OR REPLACE FUNCTION report_scores_raw(p_alg text, p_tp text, p_dim text, p_from date, p_to date, p_delta boolean,
                                             p_center_ids uuid[] DEFAULT NULL, p_surgeon uuid DEFAULT NULL)
RETURNS TABLE (gruppe text, n integer, mean numeric, sd numeric)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT DISTINCT ON (r.id) tc.id AS case_id, e.timepoint, ds.value
      FROM derived_score ds
      JOIN response r ON r.id = ds.response_id AND r.status = 'abgeschlossen'
      JOIN assessment_event e ON e.id = r.assessment_event_id
      JOIN treatment_case tc ON tc.id = r.case_id
     WHERE ds.algorithm = p_alg AND ds.kind = 'neuberechnung' AND ds.value IS NOT NULL
       AND (p_center_ids IS NULL OR tc.center_id = ANY (p_center_ids))
       AND (p_surgeon IS NULL OR tc.surgeon_user_id = p_surgeon)
       AND NOT EXISTS (SELECT 1 FROM patient rp WHERE rp.id = tc.patient_id AND rp.restricted_at IS NOT NULL)
       AND (p_from IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= p_from)
       AND (p_to IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= p_to)
       AND e.timepoint IN (p_tp, 'BL')
     ORDER BY r.id, ds.response_revision DESC
  ), v AS (
    SELECT t.case_id, CASE WHEN p_delta THEN t.value - b.value ELSE t.value END AS wert
      FROM s t LEFT JOIN s b ON b.case_id = t.case_id AND b.timepoint = 'BL'
     WHERE t.timepoint = p_tp AND (NOT p_delta OR (b.value IS NOT NULL AND p_tp <> 'BL'))
  )
  SELECT g AS gruppe, count(*)::int, round(avg(v.wert), 2), round(stddev_samp(v.wert), 2)
    FROM v CROSS JOIN LATERAL unnest(report_case_groups(v.case_id, p_dim)) AS g
   GROUP BY g
$$;

CREATE OR REPLACE FUNCTION report_characteristics_raw(p_from date, p_to date, p_center_ids uuid[] DEFAULT NULL, p_surgeon uuid DEFAULT NULL)
RETURNS TABLE (merkmal text, auspraegung text, n integer, mean numeric)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT tc.*, p.sex FROM treatment_case tc JOIN patient p ON p.id = tc.patient_id
     WHERE p.restricted_at IS NULL
       AND (p_center_ids IS NULL OR tc.center_id = ANY (p_center_ids))
       AND (p_surgeon IS NULL OR tc.surgeon_user_id = p_surgeon)
       AND (p_from IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= p_from)
       AND (p_to IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= p_to)
  ), a AS (
    SELECT DISTINCT ON (r.case_id, an.item_id) r.case_id, an.item_id, an.value_text, an.value_number
      FROM answer an JOIN response r ON r.id = an.response_id JOIN assessment_event e ON e.id = r.assessment_event_id
     WHERE an.active AND e.timepoint = 'BL' AND an.item_id IN ('bas_bmi', 'bas_vorop', 'ba_vorop', 'psport')
       AND r.case_id IN (SELECT id FROM c)
     ORDER BY r.case_id, an.item_id, an.updated_at DESC
  )
  SELECT 'faelle', 'gesamt', count(*)::int, NULL::numeric FROM c
  UNION ALL SELECT 'altersgruppe', COALESCE(age_group, 'unbekannt'), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'geschlecht', COALESCE(sex, 'nicht erfasst'), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'seite', side, count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'behandlung', treatment_type, count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'modus', (SELECT mode FROM capture_mode_history h WHERE h.case_id = c.id AND h.valid_to IS NULL), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'bmi', 'Mittelwert', count(*)::int, round(avg(value_number), 2) FROM a WHERE item_id = 'bas_bmi' AND value_number IS NOT NULL
  UNION ALL SELECT 'voroperation', value_text, count(DISTINCT case_id)::int, NULL FROM a WHERE item_id IN ('bas_vorop', 'ba_vorop') AND value_text IS NOT NULL GROUP BY 2
  UNION ALL SELECT 'sport', value_text, count(*)::int, NULL FROM a WHERE item_id = 'psport' AND value_text IS NOT NULL GROUP BY 2
$$;
