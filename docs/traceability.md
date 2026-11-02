# Traceability: Anforderungen → Implementierung → Tests → offene Freigaben

Status-Legende: **umgesetzt** (persistente Implementierung, deutsche Oberfläche, serverseitige Rechteprüfung, Test, Demonstrationsweg) ·
**teilweise** (Kern vorhanden, dokumentierte Lücke in `docs/restliste.md`) · **offen** (nicht umgesetzt).
Alle Umsetzungen sind Prototyp-Stand mit synthetischen Daten; keine Fachfreigabe.

## Funktionen F01–F19

| ID | Anforderung | Implementierung | Tests | Status | Offene Freigabe / Lücke |
|---|---|---|---|---|---|
| F01 | Zentrale Administration, keine Selbstregistrierung | `api/modules/admin.ts` (AdminController), Web `/admin` | T02-1 (Technik ohne Rechte), E2E 7 | teilweise | Antragsworkflow für Zentrumsverantwortliche fehlt (R-08) |
| F02 | Rollen, Zentrumsgrenzen, RLS, MFA | `core/auth.ts`, `migrations/core/003_*`, `005_*`, `domain/catalog.ts` | T02-1 (API, Vault-Suche, RLS direkt), T02-5/-9 (Rollen) | teilweise | MFA im Realm nicht erzwungen (R-02); Break-Glass fehlt (R-07); Qualitätsanfragen Datenmanagement fehlen (R-09) |
| F03 | Dashboard mit Suche, Pagination, Filtern, Aufgaben | `cases.ts` (list, tasks), Web `/uebersicht` | E2E 1, 7 (360 px) | umgesetzt | Kennzahlen sind Demonstrationswerte |
| F04 | Dreistufige Anlage, Consent-Gate bei Anlage und Portal-Login | `cases.ts` (create), `followup.service.ts` (consentGate), Web `/faelle/neu`, `portal.ts` (me) | T02-2, T02-4, E2E 2 | umgesetzt | Vorabkontakt-Prozess rechtlich offen (E-03) |
| F05 | Suchbare OPS-Mehrfachauswahl mit Version | `meta/ops`, `domain/catalog.ts` (OPS_EXAMPLES) | T02-3, E2E 2 | umgesetzt | Beispielkatalog, amtliche OPS-Version offen (E-13) |
| F06 | Autosave, sichtbare Zustände, Konflikt, Abschluss, Wiederöffnung | `responses.ts`, Web `useResponseEditor.tsx` | T02-9, E2E 4 | umgesetzt | – |
| F07 | Basic/Science historisiert, Register/Module, Zuordnungsmatrix | `capture_mode_history`, `domain/catalog.ts` (ASSIGNMENT_MATRIX_V1), `cases.ts` (mode) | T02-3, Unit „Zuordnungsmatrix“ | teilweise | Matrix-Pflege nur als versionierte Codedatei, nicht im Editor (R-11); Matrix fachlich offen (E-01/E-02) |
| F08 | Formulareditor, Vier-Augen, Versionen, JSON-Export/-Import | `forms.ts`, Web `/formulare`, `/formulare/[vid]` | T02-7, E2E 5 | teilweise | Gruppen nur per JSON pflegbar (R-10) |
| F09 | Regel-DSL ohne eval, Client=Server, Zyklen, inaktive Antworten | `packages/forms` (rules.ts, engine.ts) | Unit forms (18), T02-7 (Zyklus), T02-8 | umgesetzt | – |
| F10 | Versionierte Scores, Demonstrationsscore | `forms/scores.ts`, `derived_score` | Unit (7 Testwerte), T02-8 (75) | teilweise | Übernahme historischer Originalscores in `derived_score` (Art `original_historisch`) fehlt (R-13); Lizenzen offen (E-09) |
| F11 | eConsent-Zustände, aktive Zustimmung, getrennte Zeitfelder | `domain/consent.ts`, `consent.ts`, `portal.ts` | Unit, T02-4, T02-5, E2E 3 | umgesetzt | Informationstext ist Demonstration |
| F12 | Digitale Signatur (Demo) oder Papierupload, Beweispaket, Kopie | `consent.ts` (SignatureAdapter), Vault | T02-5, E2E 3, 6 | umgesetzt (Demo) | Produktionsniveau offen (E-03); in Produktion verweigert |
| F13 | Upload PDF/JPEG/PNG ≤ 20 MB, MIME/Magic, Malware, privat, Sichtprüfung | `vault/scanner.ts`, `storage.ts`, `consent.ts` (review), Web `/nachweise` | Vault-Unit, T02-5, E2E 6 | teilweise | Malware nur Demo-Adapter (EICAR), produktiver Scanner fehlt (R-04); abgelehnte Dateien werden nicht gespeichert (nur Metadaten) statt Quarantäneablage |
| F14 | Einmaliger Token nach bewusster Bestätigung, gehasht, kurzlebige Sitzung, begrenzte Versuche | `portal.ts`, `004_portal_funktionen.sql`, Web `/portal/einladung` | T02-5, T04 (abgelaufen), E2E 3, 9 | umgesetzt | – |
| F15 | Widerruf sperrt sofort Versand, Tokens, Zugriff | `consent.ts` (withdraw), `followup.service.ts` (blockPatient) | T02-6, Worker (Consent vor Versand) | teilweise | Datenumgang nach Widerruf rechtlich offen (E-07) |
| F16 | Versionierter Follow-up-Plan, kalendarisch, Datumskorrektur nur offene Termine | `domain/followup.ts`, `followup.service.ts` | Unit (Monatsende, Sommerzeit), T02-2, „Datumskorrektur“ | umgesetzt | Plan fachlich freizugeben (E-06); Nachholregeln nur als Fenster |
| F17 | Erinnerungen 7/12 Tage, Arzt +3, Outbox, Idempotenz, Retry, Dead Letter, Abgleich | `worker/outbox.ts`, `mail.ts` | T02-10 (Worker), Mailpit-Durchlauf im Compose-Stack | teilweise | Oberfläche zur Bearbeitung von Dead Letters/Abmeldungen fehlt (R-14) |
| F18 | Zentrumsberichte mit Nennern | `reports.ts`, Web `/auswertung` | Manuell/E2E nicht automatisiert | teilweise | Automatisierter Berichtstest fehlt (R-15) |
| F19 | Genehmigter, zweckgebundener Export mit Wörterbuch, Prüfsummen, Formelschutz | `reports.ts` (Exports), `worker/exports.ts` | Unit CSV, Worker-Export, API „Exportfreigabe“ | teilweise | Ebene Rohhistorie nicht exportierbar (R-16) |

## Migration M01–M06

| ID | Implementierung | Tests | Status | Lücke |
|---|---|---|---|---|
| M01 Inventar | `tools/quellen-inventar.ts`, `legacy.source_manifest`, Web `/migration` | T03 Manifest | teilweise | echte Quellsysteme/Bestände nicht geliefert (E-12) |
| M02 Unveränderte Sicherung, SHA-256, Schichten trennen | `legacy_record.raw` + Hash, `migration_batch.file_sha256` | T03 Rohwert-Nachweis | teilweise | verschlüsselte Ablage der Originalexportdatei selbst fehlt (R-17) |
| M03 Mapping nie VARID-only; P_ID, 999, BASELINE_DATE, FU3, OPS-Konzept | `domain/migration.ts` | Unit Migration, T03 | umgesetzt (synthetisch) | echtes Mapping offen (E-11) |
| M04 Null ≠ 0, Originalcodes, Klärungsliste, Vergleichbarkeitsstatus | `domain/migration.ts`, `legacy_value` | Unit, T03 | umgesetzt (synthetisch) | konkrete Klärungsfälle erst mit Q03 (E-16) |
| M05 Batches, Dry-run, idempotent, Quarantäne, Rollback, stumm | `api/modules/migration.ts` | T03 | umgesetzt | – |
| M06 Reconciliation | `migration.ts` (report), `docs/mapping-reconciliation-bericht.md` | T03 | teilweise | Scorestichproben, Anhänge, Cutover-Verfahren nur dokumentiert |

## Datenschutz und Betrieb D01–D04

| ID | Umsetzung | Status |
|---|---|---|
| D01 Rechtsgrundlagen, VVT, DSFA, Betroffenenrechte | Gliederung und Vorlagen in `docs/datenschutz.md`; Tabelle `data_subject_request` | offen (Liefergegenstände vor Pilot) |
| D02 Geringste Rechte, Verschlüsselung, MFA, Rate Limits, CSRF/XSS/Injection, Audit | Rollen/RLS, Vault-Verschlüsselung, Rate Limits, CSRF-Header, CSP, parametrisierte SQL, Audit append-only, datensparsame Logs | teilweise (TLS/Reverse Proxy, KMS, Rotation, MFA-Pflicht: R-02/R-03/R-05) |
| D03 Lösch-/Aufbewahrungsmatrix, Restore, Betroffenenrechte | Vorlage in `docs/datenschutz.md`; Restore-Probe `tools/backup-restore-probe.sh` (bestanden) | teilweise |
| D04 SLO, Performance, Release/Rollback, Monitoring | `docs/betrieb.md`; Healthchecks | offen: Lasttest mit 100.000 Fällen **nicht durchgeführt** (R-06) |

## Oberfläche U01–U03

| ID | Umsetzung | Tests | Status |
|---|---|---|---|
| U01 Design-Tokens, Schrift selbst gehostet | `globals.css`, `packages/ui` | 12 Kontrastpaare | umgesetzt (Logo nicht geliefert) |
| U02 WCAG 2.2 AA | Labels, Fokus, Fehlerzusammenfassung, aria-live Autosave, Signatur-Alternative, 360 px | E2E: Labels, Fokus, Sprunglink, 360 px | teilweise (kein vollständiger Screenreader-/Audit-Test, R-18) |
| U03 Vier Ansichten + Editor, Zustände | Dashboard, Anlage, Arztbogen, Portal, Editor | E2E 1–9, Screenshots | umgesetzt |

## Tests T01–T04

| ID | Umsetzung | Status |
|---|---|---|
| T01 REST v1, OpenAPI, Fehlercodes, If-Match, Idempotency-Key | `docs/api/openapi.json` (73 Pfade), `errors.ts`, `http.ts` | umgesetzt |
| T02 Abnahmefälle 1–10 | `apps/api/test/t02-abnahme.test.ts`, `apps/worker/test/t02-10-versand.test.ts` | alle 10 bestanden |
| T03 Migrationstests | `apps/api/test/t03-migration.test.ts`, Unit Migration | bestanden (synthetisch); 1.441-Zeilen-Prüfung und V05-Hash erst mit Quelle |
| T04 Zusatzprüfungen | Upload/MIME/Malware, abgelaufener Link, Linkscanner, E-Mail-Fehler (Dead Letter), Datumskorrektur, Monatsende/Sommerzeit, Schemazyklus, unzulässiger Export, CSV-Formelinjektion, Tastatur, 360 px, Persistenz nach Neustart, Restore | bestanden; Screenreader-Test offen |
