# ADR-0002: Identity Vault als eigenständige Sicherheitsgrenze

Status: angenommen · Datum: 02.11.2026

## Entscheidung
- Eigener Dienst `apps/vault` mit **eigener Datenbank** (`dart_vault`, eigener PostgreSQL-Server im Compose, eigenes Netzwerk `vault`),
  eigenen Zugangsdaten (`vault_owner`, `vault_app`) und eigenen Schlüsseln (`VAULT_DATA_KEY`, `VAULT_INDEX_KEY`).
- Der Forschungskern hat **keine** Datenbankrechte auf den Vault; API und Worker sprechen den Vault nur per HTTP mit getrennten Diensttokens an.
- Im Vault: Name, E-Mail, optional Geburtsdatum (feldweise AES-256-GCM verschlüsselt), Zugangscode (scrypt-Hash),
  Signaturbild, unterschriebene Dokumente und Beweispakete (vor dem Speichern verschlüsselt, im S3-Speicher ohne öffentliche URLs).
- Klarnamensuche nur über HMAC-Index im Vault (`/identities/search`), begrenzt auf die Zentren des Aufrufers, protokolliert.
- Jeder Vault-Zugriff landet im unveränderlichen `access_log` (ohne Inhalte).

## Grenzen im Prototyp
- Die API übermittelt die zulässigen Zentren per Header; der Vault vertraut dem authentisierten API-Dienst (Defense in Depth: zusätzlicher Abgleich mit dem Zentrum der Identität).
  Produktiv: mTLS zwischen Diensten, Schlüssel aus einem KMS/HSM, Rotation (Restliste R-03).
- Geburtsdatum ist optional und nur zu erfassen, wenn fachlich freigegeben (Entscheidung E-05).
