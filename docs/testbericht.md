# Testbericht

Ausführung: 02.11.2026, lokale Umgebung (Linux, Node.js 22, PostgreSQL 18 im Container, Chromium headless).
Alle Daten synthetisch. Fehlschläge werden nicht als bestanden ausgewiesen.

## Ergebnisse

| Suite | Befehl | Ergebnis |
|---|---|---|
| Formularengine, Regel-DSL, Scores, Verzweigungsassistent, Versionsvergleich | `packages/forms: vitest` | **42 / 42 bestanden** (inkl. IKDC/KOOS-Referenzwerte) |
| Domäne (Follow-up, Einwilligung, Matrix, Rechte, CSV, Migration, Katalog-Mapping V05, Altersgruppe/KI) | `packages/domain: vitest` | **21 / 21 bestanden** |
| Design-Tokens (WCAG-Kontrast) | `packages/ui: vitest` | **12 / 12 bestanden** |
| Vault (Upload-Prüfung, Kryptografie) | `apps/vault: vitest` | **4 / 4 bestanden** |
| API: T02-1 … T02-9, Export, abgelaufener Link, T03 inkl. Variablenkatalog V05, T05 Autoreport, T06 Versand-Leitstand, T07 Formulareditor, T08 Betroffenenrechte | `apps/api: vitest` | **50 / 50 bestanden** |
| Worker: T02-10, Dead Letter, Consent vor Versand, Abmeldung, abgewiesener Empfänger, Versuchsbudget, eingeschränkte Verarbeitung, Export | `apps/worker: vitest` | **8 / 8 bestanden** |
| Browser-E2E (lokal) | `tests/e2e: playwright` | **14 / 14 bestanden**, 1 übersprungen (OIDC, nur mit Profil) |
| Quellenprüfung Q02/Q03 | `pnpm katalog` | **17 / 17 Kennzahlen** stimmen mit dem Lastenheft (inkl. unabhängiger Neuberechnung aus V05) |
| GitHub Actions (CI) | `.github/workflows/ci.yml` | alle Schritte grün (Build, Unit, Migration, API, Worker, E2E) |
| Browser-E2E OIDC (Keycloak im Compose-Stack, `E2E_OIDC=1`) | `tests/e2e: playwright oidc` | **1 / 1 bestanden** |

Gefundene und behobene Fehler während der Tests (Auszug): mehrdeutige SQL-Spalte in der Konfliktantwort (Autosave-Konflikt lieferte 500 statt 409);
Selbstbezug in Prüfregeln wurde fälschlich abgelehnt; bei 360 px ragten Navigationsleiste, versteckte Tabellenköpfe und lange Codes in der
Falldetailansicht über den Rand. Die 360-px-Prüfung wurde daraufhin verschärft (Seitenbreite **und** Elementgrenzen).

Hinweis: Ein E2E-Test (Tastaturfokus) war anfangs instabil (Fokus vor dem Laden der Liste). Ursache behoben (Warten auf die Liste);
danach vier aufeinanderfolgende Läufe ohne Fehler.

## Infrastrukturprüfungen

| Prüfung | Ergebnis |
|---|---|
| `docker compose up --build` (Images über `IMAGE_MIRROR=mirror.gcr.io`) | alle Dienste „healthy“: db, vault-db, s3, mailpit, vault, api, worker, web; migrate erfolgreich beendet |
| Persistenz nach `docker compose down` / `up` | Fallzahl und neuester Fall identisch (`var/persist.sh`-Prüfung) |
| Restore-Probe (`tools/backup-restore-probe.sh`) | **bestanden** – Zeilenzahlen von 8 Kerntabellen vor/nach `pg_dump`/`pg_restore` identisch |
| Produktionsstart mit Demo-Werten (`NODE_ENV=production`) | API, Vault und Worker **verweigern** den Start mit Begründung |
| Vault-Daten im Ruhezustand | Namen in `identity` nicht im Klartext lesbar; Dokumente im S3-Speicher, unauthentisches Listen → 403 |
| RLS-Flags | `relrowsecurity` und `relforcerowsecurity` = true für Fachtabellen; Laufzeitrolle ohne Superuser/BYPASSRLS (auch per Test geprüft) |
| Worker-Versand im Compose-Stack | Einladung in Mailpit zugestellt; Message-ID-Abgleich über Mailpit-API funktioniert |
| OIDC-Anmeldung | Authorization Code + PKCE über Keycloak 26.4 erfolgreich |

## Nicht durchgeführt / Grenzen

- **Lasttest** (100.000 Fälle, 100 gleichzeitige Nutzer, p95 < 800 ms) – nicht durchgeführt; Zielwerte aus D04 sind **nicht** belegt.
- **Screenreader-Test** (NVDA/VoiceOver) – nicht durchgeführt; automatisiert geprüft wurden nur Beschriftungen, Fokus, Sprunglink und 360 px (Dashboard, Falldetail, Portal); aria-live ist implementiert, aber nicht automatisiert geprüft.
- **Penetrationstest** – nicht durchgeführt.
- **Produktiver Malwarescanner** – nur Demo-Adapter (EICAR).
- **Migration echter Bestände** – Q02/Q03 liegen vor und sind geprüft; echte Patientenexporte liegen nicht vor. Migrationstests mit synthetischen Werten (auch mit echten V05-Spaltennamen).
- Datumsfelder: seit 03.11.2026 eigene Eingabe TT.MM.JJJJ unabhängig von der Browsersprache (R-20), geprüft per Unit-Tests (Schaltjahr, 31.04., zweistellige Jahre) und E2E (31.02.2026 wird abgelehnt).

## Testumgebung reproduzieren

```bash
# Datenbanken (PostgreSQL 18) mit Rollen
docker run -d --name dart-dev-db -p 55432:5432 -e POSTGRES_PASSWORD=dev_super -e DART_OWNER_PASSWORD=dev_owner -e DART_APP_PASSWORD=dev_app -e DART_WORKER_PASSWORD=dev_worker -e DART_MIGRATION_PASSWORD=dev_migration -v $PWD/infra/postgres/core-init.sh:/docker-entrypoint-initdb.d/10-init.sh:ro postgres:18-alpine
```

```bash
docker run -d --name dart-dev-vaultdb -p 55433:5432 -e POSTGRES_PASSWORD=dev_super -e VAULT_OWNER_PASSWORD=dev_vowner -e VAULT_APP_PASSWORD=dev_vapp -v $PWD/infra/postgres/vault-init.sh:/docker-entrypoint-initdb.d/10-init.sh:ro postgres:18-alpine
```

```bash
docker run -d --name dart-dev-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit:v1.27
```

Umgebungsvariablen (Beispiel `var/dev.env`, nicht eingecheckt):
`APP_DATABASE_URL=postgres://dart_app:dev_app@localhost:55432/dart`, `MIGRATION_DATABASE_URL=postgres://dart_migration:dev_migration@localhost:55432/dart`,
`WORKER_DATABASE_URL=postgres://dart_worker:dev_worker@localhost:55432/dart`, `SEED_DATABASE_URL=postgres://dart_owner:dev_owner@localhost:55432/dart`,
`VAULT_DATABASE_URL=postgres://vault_app:dev_vapp@localhost:55433/dart_vault`, Vault-Schlüssel/-Tokens und `SESSION_SECRET` aus `.env.example`,
`VAULT_URL=http://localhost:4100`, `VAULT_LOCAL_DIR=./var/vault-objects`, `AUTH_MODE=dev`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`,
`MAILPIT_API=http://localhost:8025`, für API-Tests zusätzlich `RATE_LIMIT_MULTIPLIER=100` (in Produktion verweigert).
Danach Migrationen, Seed, Dienste starten, synthetische Demodaten laden (`node apps/api/dist/demo-daten.js`, 300 Fälle) und `pnpm test`, `pnpm --filter @dart/worker test`, `pnpm test:e2e` ausführen.

Rohdaten des letzten E2E-Laufs: `docs/testbericht/e2e-ergebnis.json`.
