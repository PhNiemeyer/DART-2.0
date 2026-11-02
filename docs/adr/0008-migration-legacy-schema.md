# ADR-0008: Historische Migration im getrennten Schema „legacy“

Status: angenommen (Prototyp) · Datum: 02.11.2026

- Rohhistorie (`legacy.legacy_record.raw`, unverändert, SHA-256), normalisierte Werte (`legacy.legacy_value`, mit Provenienz,
  Mappingversion und Vergleichbarkeitsstatus) und Klärungsliste (`legacy.reconciliation_issue`) sind getrennt; nur die Rolle `dart_migration` hat Zugriff.
- Mapping immer über Quellsystem, Exportversion, Blatt, Spaltenname bzw. SAS-Alias – **nie VARID-only**.
- Eindeutiger Quellschlüssel (Quellsystem, Exportversion, Blatt, Zeile) macht Wiederholungen idempotent; Rollback je Batch.
- Bilanz: geliefert = normalisiert + archiviert + ungeklärt + Quarantäne (Zeilen und Zellen).
- Migration ist stumm: keine Einladungen, keine Kontoaktivierung.
- Im Prototyp **keine Übernahme in Live-Fälle**: Personenverknüpfung erst über bestätigte `legacy_key_map` (P_ID ist keine Patientenkennung).
  Die Mappingversion ist synthetisch (`SYNTHETIC_MAPPING_V1`), da die Originalquellen (Q02/Q03) nicht vorliegen.
