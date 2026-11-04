-- Versand-Leitstand (R-14): Bearbeitung von Dead Letters, Zustellfehlern, unklaren Zustellungen und Abmeldungen.
-- Abmeldung betrifft nur den E-Mail-Kanal; Einwilligung und Befragungen bleiben unberührt.

-- Kontaktstatus je Patient (E-Mail-Kanal). Fehlt eine Zeile, gilt „aktiv“.
CREATE TABLE contact_preference (
  patient_id uuid PRIMARY KEY REFERENCES patient(id),
  center_id uuid NOT NULL REFERENCES center(id),
  email_status text NOT NULL CHECK (email_status IN ('aktiv','abgemeldet','unzustellbar')),
  source text NOT NULL CHECK (source IN ('portal','zentrum','versand')),
  reason text CHECK (length(reason) <= 300),
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contact_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY api_center ON contact_preference TO dart_app USING (center_id = ANY (dart_center_ids())) WITH CHECK (center_id = ANY (dart_center_ids()));
CREATE POLICY api_patient_scope ON contact_preference AS RESTRICTIVE TO dart_app USING (dart_patient_id() IS NULL OR patient_id = dart_patient_id());
CREATE POLICY worker_all ON contact_preference TO dart_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON contact_preference TO dart_app, dart_worker;

-- Versuchsbudget je Nachricht: erneutes Einreihen erhöht das Budget, statt Versuche zurückzusetzen
-- (Versuchsnummern im Versandjournal bleiben eindeutig und lückenlos).
ALTER TABLE outbox_message ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50);
ALTER TABLE outbox_message ADD COLUMN handled_by uuid REFERENCES app_user(id);
ALTER TABLE outbox_message ADD COLUMN handled_at timestamptz;
ALTER TABLE outbox_message ADD COLUMN handling_note text CHECK (length(handling_note) <= 300);
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS outbox_message_status_check;
ALTER TABLE outbox_message ADD CONSTRAINT outbox_message_status_check
  CHECK (status IN ('ausstehend','in_versand','versendet','unklar','fehlgeschlagen','dead_letter','storniert'));
ALTER TABLE delivery_attempt DROP CONSTRAINT IF EXISTS delivery_attempt_result_check;
ALTER TABLE delivery_attempt ADD CONSTRAINT delivery_attempt_result_check
  CHECK (result IN ('versendet','fehler','unklar','storniert','abgeglichen','unzustellbar'));
CREATE INDEX IF NOT EXISTS outbox_message_center_status_idx ON outbox_message (center_id, status, updated_at DESC);

-- Zentrale Übersicht ohne Patientenbezug: nur Anzahlen je Zentrum und Status (SECURITY DEFINER, keine IDs).
CREATE OR REPLACE FUNCTION dispatch_overview() RETURNS TABLE (center_code text, center_name text, status text, n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.name, o.status, count(*)::int
    FROM outbox_message o JOIN center c ON c.id = o.center_id
   WHERE o.kind <> 'export'
   GROUP BY c.code, c.name, o.status
   ORDER BY c.code, o.status
$$;
REVOKE ALL ON FUNCTION dispatch_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dispatch_overview() TO dart_app;
