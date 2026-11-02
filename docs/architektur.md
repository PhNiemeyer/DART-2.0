# Architektur und Datenmodell

## Komponenten und Sicherheitsgrenzen

```mermaid
flowchart LR
  subgraph Browser
    S[Personal<br/>Next.js-Oberfläche]
    P[Patientenportal<br/>mobil]
  end
  subgraph core["Netz core"]
    W[web<br/>Next.js + API-Proxy<br/>no-store]
    A[api<br/>NestJS modularer Monolith<br/>REST v1, OpenAPI]
    K[worker<br/>Outbox, Erinnerungen, Exporte]
    DB[(PostgreSQL 18 „dart“<br/>Forschungskern, pseudonym<br/>FORCE RLS)]
    M[Mailpit<br/>lokal]
    KC[Keycloak<br/>OIDC, optional]
  end
  subgraph vaultnet["Netz vault"]
    V[vault<br/>Identität, Kontakt,<br/>Signatur, Dokumente]
    VDB[(PostgreSQL 18 „dart_vault“<br/>eigener Server)]
    S3[(S3-Speicher<br/>SeaweedFS, privat,<br/>vorab verschlüsselt)]
  end
  S --> W
  P --> W
  W -->|/api/v1| A
  A -->|dart_app, RLS| DB
  A -->|dart_migration, Schema legacy| DB
  A -->|Diensttoken API| V
  K -->|dart_worker| DB
  K -->|Diensttoken Worker: nur Kontakt| V
  K -->|SMTP + Abgleich| M
  A -.->|OIDC Code + PKCE| KC
  V --> VDB
  V --> S3
```

- **Forschungskern** (`dart`): ausschließlich pseudonyme Daten; keine Namen, Kontakte, Signaturen.
- **Vault** (`dart_vault` + S3): eigene Datenbank auf eigenem Server, eigene Schlüssel, eigenes Netzwerk. Der Kern hat keine DB-Rechte darauf.
- **Datenbankrollen:** `dart_owner` (nur Migration/Seed), `dart_app` (API, RLS), `dart_worker` (Versand/Export), `dart_migration` (Schema `legacy`).
- **Outbox:** fachliche Änderung und Versandauftrag in einer Transaktion; der Worker versendet idempotent.
- **Caching:** Alle Antworten `private, no-store`; keine Gesundheitsdaten in URLs (UUIDs und Fallnummern sind keine Gesundheitsdaten; Einladungstoken nur im URL-Fragment).

## Fachmodule der API

| Modul | Datei | Inhalt |
|---|---|---|
| Anmeldung, Stammdaten, Administration | `modules/admin.ts` | Demo-/OIDC-Anmeldung, Katalog, OPS-Suche, Zentren, Konten, Rollen, Audit |
| Patienten/Fälle | `modules/cases.ts` | Dashboard, Aufgaben, Anlage, Detail, Identität (Vault), Klarnamensuche, Datumskorrektur, Moduswechsel |
| Follow-up | `modules/followup.service.ts` | Consent-Gate, Aktivierung, Zeitachse, Outbox-Planung, Sperre bei Widerruf |
| Einwilligung | `modules/consent.ts` | Vorbereitung, Vor-Ort-Einladung, Upload, Sichtprüfung, Widerruf, Signaturadapter |
| Erhebungen | `modules/responses.ts` | Laden, Autosave mit If-Match, Abschluss, Wiederöffnung, Revisionen, Scores |
| Patientenportal | `modules/portal.ts` | Einlösen, Zugangscode, Übersicht, Signatur, Kopie, Widerruf, Befragung, neuer Link |
| Formulare | `modules/forms.ts` | Entwurf, Prüfung, Freigabe, Veröffentlichung, Ruhestand, Export/Import |
| Auswertung/Export | `modules/reports.ts` | Zentrumsbericht, Exportantrag, Genehmigung, Download |
| Migration | `modules/migration.ts` | Probelauf, Import, Rollback, Reconciliation, Quellenmanifest |

## Datenmodell (Kern)

```mermaid
erDiagram
  center ||--o{ user_center_role : ""
  app_user ||--o{ user_center_role : ""
  center ||--o{ center_science_approval : ""
  center ||--o{ patient : ""
  patient ||--o{ treatment_case : "1:n"
  treatment_case ||--o{ case_register_membership : "n:m Register"
  treatment_case ||--o{ capture_mode_history : "Basic/Science historisiert"
  treatment_case ||--o{ case_module : "n:m Module"
  treatment_case ||--o{ procedure : "OPS + Konzept + Version"
  patient ||--o{ consent_record : ""
  consent_document_version ||--o{ consent_record : ""
  consent_record ||--o{ withdrawal_event : ""
  treatment_case ||--o{ assessment_event : "Zeitachse"
  assessment_event ||--o{ response : ""
  questionnaire ||--o{ questionnaire_version : "unveränderlich nach Veröffentlichung"
  questionnaire_version ||--o{ response : "Version bleibt fix"
  questionnaire_version ||--o{ variable_definition_version : ""
  variable_concept ||--o{ variable_definition_version : ""
  response ||--o{ answer : "Schlüssel: Item + Instanz"
  response ||--o{ response_revision : "vollständige Historie"
  response ||--o{ derived_score : "Neuberechnung/Original getrennt"
  patient ||--o{ invitation : "Token-Hash"
  invitation ||--o{ patient_session : ""
  treatment_case ||--o{ outbox_message : "Idempotenzschlüssel"
  outbox_message ||--o{ delivery_attempt : "Versandjournal"
  export_job ||--o{ export_file : "Prüfsummen"
```

Weitere Tabellen: `audit_event` (append-only), `idempotency_record`, `data_subject_request`, `score_algorithm_version`,
`followup_plan_version`, `assignment_matrix_version`. Schema `legacy`: `source_manifest`, `mapping_rule_version`, `migration_batch`,
`legacy_record` (Rohwert), `legacy_value` (normalisiert, Provenienz), `legacy_key_map`, `reconciliation_issue`.
Vault: `identity` (verschlüsselte Felder, HMAC-Namensindex, Zugangscode-Hash), `document`, `access_log`.

### Zentrale Invarianten (in Datenbank und Code erzwungen)

- `answer`: genau ein Wert **oder** ein zulässiger Fehlgrund (CHECK); Schlüssel = Antwortinstanz + Item + Wiederholungsinstanz.
- `consent_record`: „gültig“ nur mit Nachweis, Hash, Prüfzeit und Unterschriftsdatum (CHECK).
- `treatment_case`: operativ braucht geplantes oder tatsächliches OP-Datum, konservativ einen eigenen Behandlungsbeginn; Patient und Fall im selben Zentrum (Trigger).
- `questionnaire_version`: veröffentlicht/Ruhestand unveränderlich (Trigger), höchstens eine veröffentlichte Version je Formular.
- `outbox_message.idempotency_key`, `legacy_record`-Quellschlüssel, `response (Ereignis, Formularversion)`: UNIQUE.
- `export_job`: Entscheider ≠ Antragsteller (CHECK). Datum ohne Uhrzeit als `DATE`, Zeitstempel `timestamptz` (UTC), Anzeige de-DE/Europe-Berlin.
