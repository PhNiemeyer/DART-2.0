-- DART 2.0 – Identity Vault (eigene Datenbank, eigene Zugangsdaten, eigene Schlüssel).
-- Enthält Identität, Kontakt, Zugangscode-Hash, Signaturen und unterschriebene Dokumente.
-- Der Forschungskern hat KEINE Rechte auf diese Datenbank.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE identity (
  vault_ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id uuid NOT NULL,
  first_name_enc bytea NOT NULL,
  last_name_enc bytea NOT NULL,
  email_enc bytea,
  birth_date_enc bytea,
  -- Suchindex: HMAC über normalisierten Nachnamen (keine Klartextsuche in der DB)
  last_name_hmac text NOT NULL,
  access_code_hash text,
  access_code_set_at timestamptz,
  synthetic boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON identity (center_id, last_name_hmac);

CREATE TABLE document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_ref uuid NOT NULL REFERENCES identity(vault_ref),
  center_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('einwilligung_papier','signatur_demo','einwilligung_kopie')),
  original_name text,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  scan_status text NOT NULL CHECK (scan_status IN ('quarantaene','sauber','infiziert','abgelehnt')),
  scan_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE access_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  caller text NOT NULL,
  actor text,
  action text NOT NULL,
  vault_ref uuid,
  document_id uuid,
  result text NOT NULL,
  request_id text
);

CREATE OR REPLACE FUNCTION trg_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Zugriffsprotokoll ist unveränderlich'; END $$;
CREATE TRIGGER access_log_no_update BEFORE UPDATE OR DELETE ON access_log FOR EACH ROW EXECUTE FUNCTION trg_log_append_only();

GRANT SELECT, INSERT, UPDATE ON identity, document TO vault_app;
GRANT INSERT ON access_log TO vault_app;
GRANT USAGE ON SEQUENCE access_log_id_seq TO vault_app;
