-- Patientensitzung: alle fallbezogenen Tabellen zusätzlich auf eigene Fälle begrenzen (restriktive Policies).
CREATE POLICY api_patient_scope ON assessment_event AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR case_id IN (SELECT id FROM treatment_case));
CREATE POLICY api_patient_scope ON response AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR case_id IN (SELECT id FROM treatment_case));
CREATE POLICY api_patient_scope ON answer AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR response_id IN (SELECT id FROM response));
CREATE POLICY api_patient_scope ON response_revision AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR response_id IN (SELECT id FROM response));
CREATE POLICY api_patient_scope ON derived_score AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR response_id IN (SELECT id FROM response));
CREATE POLICY api_patient_scope ON invitation AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR patient_id = dart_patient_id());
CREATE POLICY api_patient_scope ON withdrawal_event AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR consent_id IN (SELECT id FROM consent_record));
CREATE POLICY api_patient_scope ON outbox_message AS RESTRICTIVE TO dart_app
  USING (dart_patient_id() IS NULL OR patient_id = dart_patient_id());
