-- Historische Migration: eigenes Schema „legacy“, nur für Rolle dart_migration zugänglich.
-- Rohhistorie (legacy_record.raw) bleibt unverändert; normalisierte Werte sind getrennt (legacy_value).

CREATE SCHEMA legacy;

CREATE TABLE legacy.source_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL,
  file_name text NOT NULL,
  expected_sha256 text,
  actual_sha256 text,
  size_bytes bigint,
  status text NOT NULL CHECK (status IN ('vorhanden','fehlt','abweichende_version','synthetisch')),
  note text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_code, file_name)
);

CREATE TABLE legacy.mapping_rule_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('vorschlag','freigegeben')),
  definition jsonb NOT NULL,
  definition_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE legacy.migration_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  export_version text NOT NULL,
  mapping_version_id uuid NOT NULL REFERENCES legacy.mapping_rule_version(id),
  file_name text NOT NULL,
  file_sha256 text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('probelauf','import')),
  status text NOT NULL CHECK (status IN ('probelauf','importiert','zurueckgerollt','fehler')),
  silent boolean NOT NULL DEFAULT true,
  summary jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by uuid
);

CREATE TABLE legacy.legacy_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES legacy.migration_batch(id),
  source_system text NOT NULL,
  export_version text NOT NULL,
  sheet text NOT NULL,
  source_row integer NOT NULL,
  record_id text,
  raw jsonb NOT NULL,
  raw_sha256 text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('normalisiert','archiviert','ungeklaert','quarantaene')),
  center_id uuid,
  timepoint text,
  op_date date,
  side text,
  procedures jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- unverwechselbarer Quellschlüssel: Doppelimport erzeugt keine Dubletten
  UNIQUE (source_system, export_version, sheet, source_row)
);

CREATE TABLE legacy.legacy_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_record_id uuid NOT NULL REFERENCES legacy.legacy_record(id) ON DELETE CASCADE,
  column_name text NOT NULL,
  source_key text NOT NULL,
  var_id text,
  concept text,
  raw_value text NOT NULL,
  normalized jsonb,
  comparability text NOT NULL CHECK (comparability IN ('direkt','transformiert','nicht_vergleichbar','ungeklaert')),
  outcome text NOT NULL CHECK (outcome IN ('normalisiert','archiviert','ungeklaert')),
  mapping_version_id uuid NOT NULL REFERENCES legacy.mapping_rule_version(id),
  UNIQUE (legacy_record_id, column_name)
);

CREATE TABLE legacy.legacy_key_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  legacy_key text NOT NULL,
  target_patient_id uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  note text,
  UNIQUE (source_system, legacy_key)
);

CREATE TABLE legacy.reconciliation_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES legacy.migration_batch(id),
  legacy_record_id uuid REFERENCES legacy.legacy_record(id) ON DELETE CASCADE,
  source_row integer,
  code text NOT NULL,
  message text NOT NULL,
  column_name text,
  blocking boolean NOT NULL,
  status text NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','geklaert','akzeptiert'))
);
CREATE INDEX ON legacy.reconciliation_issue (batch_id, code);
