-- Eng begrenzte SECURITY-DEFINER-Funktionen für das Patientenportal: Ein Token bzw. eine
-- Sitzung kann ohne Zentrumskontext nachgeschlagen werden, liefert aber nur die minimalen
-- Zuordnungsdaten. Die eigentliche Datenabfrage läuft danach wieder unter RLS.

CREATE OR REPLACE FUNCTION portal_find_invitation(p_token_hash text)
RETURNS TABLE (id uuid, center_id uuid, patient_id uuid, case_id uuid, assessment_event_id uuid, purpose text,
               status text, expires_at timestamptz, failed_attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.center_id, i.patient_id, i.case_id, i.assessment_event_id, i.purpose, i.status, i.expires_at, i.failed_attempts
  FROM invitation i WHERE i.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION portal_find_session(p_session_hash text)
RETURNS TABLE (id uuid, patient_id uuid, center_id uuid, invitation_id uuid, verified boolean, verify_attempts integer,
               expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.patient_id, s.center_id, s.invitation_id, s.verified, s.verify_attempts, s.expires_at, s.revoked_at
  FROM patient_session s WHERE s.session_hash = p_session_hash
$$;

REVOKE ALL ON FUNCTION portal_find_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION portal_find_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_find_invitation(text) TO dart_app;
GRANT EXECUTE ON FUNCTION portal_find_session(text) TO dart_app;
