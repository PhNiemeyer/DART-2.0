-- Variablenkatalog Knie V05 (aus Q02/Q03). Nur Schema legacy; Entscheidungen sind Vorschläge ohne Freigabe.
CREATE TABLE legacy.catalog_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_code text NOT NULL,
  source_sha256 text NOT NULL,
  sheet text NOT NULL,
  source_row integer NOT NULL,
  alt_name text NOT NULL,
  sas_alias text,
  var_id text,
  dart_id text,
  klasse text NOT NULL CHECK (klasse IN ('Übernahme','Überarbeitung','Entfall')),
  klasse_code text NOT NULL CHECK (klasse_code IN ('A','B','C')),
  label text,
  basic_science text,
  vergleichbarkeit text,
  pruefhinweise text[] NOT NULL DEFAULT '{}',
  entscheidung text NOT NULL,
  freigabe_durch text,
  details jsonb NOT NULL,
  UNIQUE (catalog_code, sheet, source_row)
);
CREATE INDEX ON legacy.catalog_entry (catalog_code, sheet);

CREATE TABLE legacy.catalog_neuanlage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_code text NOT NULL,
  position integer NOT NULL,
  zielstruktur text NOT NULL,
  details jsonb NOT NULL,
  UNIQUE (catalog_code, position)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON legacy.catalog_entry, legacy.catalog_neuanlage TO dart_migration;
