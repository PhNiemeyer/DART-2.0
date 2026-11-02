-- Rechte und Row Level Security (F02): FORCE RLS; Laufzeitrollen ohne Owner/Superuser/BYPASSRLS.
-- Die Rollen dart_app, dart_worker, dart_migration werden vom Infrastruktur-Init angelegt.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO dart_app, dart_worker;
GRANT USAGE ON SCHEMA legacy TO dart_migration;
GRANT USAGE ON SCHEMA public TO dart_migration;

-- Stammdaten (keine Gesundheitsdaten): lesbar für API
GRANT SELECT ON center, center_science_approval, app_user, user_center_role, questionnaire, questionnaire_version,
  variable_concept, variable_definition_version, score_algorithm_version, followup_plan_version, assignment_matrix_version,
  consent_document_version TO dart_app, dart_worker;
GRANT INSERT, UPDATE ON center, center_science_approval, app_user, user_center_role TO dart_app;
GRANT DELETE ON user_center_role TO dart_app;
GRANT INSERT, UPDATE ON questionnaire, questionnaire_version, variable_concept, variable_definition_version TO dart_app;
GRANT DELETE ON questionnaire_version TO dart_app;

-- Fachdaten
GRANT SELECT, INSERT, UPDATE ON patient, treatment_case, case_register_membership, capture_mode_history, case_module,
  procedure, consent_record, withdrawal_event, assessment_event, response, response_revision, answer, derived_score,
  invitation, patient_session, outbox_message, data_subject_request TO dart_app;
GRANT DELETE ON answer, procedure TO dart_app;
GRANT USAGE ON SEQUENCE case_no_seq TO dart_app;
GRANT SELECT, INSERT ON idempotency_record TO dart_app;
GRANT SELECT, INSERT, UPDATE ON export_job TO dart_app;
GRANT SELECT ON export_file TO dart_app;
GRANT SELECT ON delivery_attempt TO dart_app;

-- Audit: nur anhängen (UPDATE/DELETE zusätzlich per Trigger gesperrt)
GRANT INSERT ON audit_event TO dart_app, dart_worker, dart_migration;
GRANT USAGE ON SEQUENCE audit_event_id_seq TO dart_app, dart_worker, dart_migration;
GRANT SELECT ON audit_event TO dart_app;

-- Worker: Versand, Einwilligungsprüfung, Export
GRANT SELECT ON patient, treatment_case, case_register_membership, capture_mode_history, case_module, procedure,
  consent_record, assessment_event, response, answer, derived_score TO dart_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_message, delivery_attempt, invitation TO dart_worker;
GRANT UPDATE (status) ON assessment_event TO dart_worker;
GRANT SELECT, UPDATE ON export_job TO dart_worker;
GRANT SELECT, INSERT ON export_file TO dart_worker;

-- Migration: eigenes Schema; liest Zentren zur Zuordnung
GRANT SELECT ON center TO dart_migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA legacy TO dart_migration;

-- ---------------------------------------------------------------------------
-- RLS auf allen zentrumsbezogenen Fachtabellen
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient','treatment_case','case_register_membership','capture_mode_history','case_module',
    'procedure','consent_record','withdrawal_event','assessment_event','response','response_revision','answer',
    'derived_score','invitation','patient_session','outbox_message','data_subject_request']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- API: nur Zentren aus der Transaktionsvariable app.center_ids
    EXECUTE format('CREATE POLICY api_center ON %I TO dart_app USING (center_id = ANY (dart_center_ids())) WITH CHECK (center_id = ANY (dart_center_ids()))', t);
    -- Worker: verarbeitet zentrumsübergreifend (Versand/Export), Rechte per GRANT minimal
    EXECUTE format('CREATE POLICY worker_all ON %I TO dart_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Patientensitzung: zusätzlich auf den eigenen Patienten begrenzt, sobald app.patient_id gesetzt ist
CREATE POLICY api_patient_scope ON patient AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR id = dart_patient_id());
CREATE POLICY api_patient_scope ON treatment_case AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR patient_id = dart_patient_id());
CREATE POLICY api_patient_scope ON consent_record AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR patient_id = dart_patient_id());

-- Audit- und Exporttabellen: RLS aktiv; Lesen nur über berechtigte API-Endpunkte
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_event FOR INSERT TO dart_app, dart_worker, dart_migration WITH CHECK (true);
CREATE POLICY audit_read ON audit_event FOR SELECT TO dart_app
  USING (current_setting('app.audit_reader', true) = 'on' OR center_id = ANY (dart_center_ids()));
