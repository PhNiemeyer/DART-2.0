# DART 2.0 – Registerplattform (lokaler Prototyp)

> **Prototyp – ausschließlich synthetische Daten.** Dieser Stand ist **keine Freigabe für echte Patientendaten**.
> Produktivbetrieb bleibt gesperrt, bis Verantwortliche, Datenschutz, Ethik/Studienleitung, Inhalte/Scorelizenzen,
> Migration, Penetrationstest, Restore, Betrieb und Pilotabnahme dokumentiert freigegeben sind (Lastenheft Kap. 27).

Gemeinsamer Kern für **DART Basic, DART Science, KnorpelRegister DGOU und DEKOR**; Knie zuerst, Schulter/Hüfte/Sprunggelenk
architektonisch vorbereitet. Grundlage: *Lastenheft DART 2.0, Fassung 1.0* und *Coding-Masterprompt* (beide in `docs/quellen/`).

## Schnellstart

Voraussetzungen: Docker (mit Compose v2), ca. 4 GB freier Arbeitsspeicher. Für die Entwicklung ohne Docker zusätzlich Node.js ≥ 22 und pnpm 10.

```bash
docker compose up --build
```

Danach:

| Dienst | URL | Hinweis |
|---|---|---|
| Webanwendung | http://localhost:3000 | Anmeldung über Demo-Nutzerauswahl |
| Patientenportal | http://localhost:3000/portal/einladung | Link entsteht im Fall („Vor-Ort-Zugang erzeugen“) oder per E-Mail |
| Mailpit (Test-Postfach) | http://localhost:8025 | Einladungen und Erinnerungen des Workers |
| API / OpenAPI | http://localhost:4000/api/docs | nur außerhalb von Produktion |
| Keycloak (optional) | http://localhost:8080 | nur mit Profil `oidc`, siehe unten |

Der Start legt die Datenbanken an, spielt Migrationen ein und erzeugt synthetische Stammdaten (Zentren, Konten, Demonstrationsbögen).
Patientenfälle legen Sie in der Anwendung an. Alle Daten bleiben nach einem Neustart erhalten (Docker-Volumes).

### Testkonten (nur lokal)

Auf `/anmelden` erscheint im Modus `AUTH_MODE=dev` eine Auswahl. Kein Passwort – **in Produktion wird dieser Modus verweigert**.

| Konto | Rolle | Zentrum |
|---|---|---|
| `admin` | Zentrale Administration | – |
| `dr.nord`, `dr.nord2` | Arzt/Ärztin | Demo-Zentrum Nord (Science freigegeben) |
| `doku.nord` | Dokumentationskraft | Nord |
| `leitung.nord` | Zentrumsverantwortliche/r | Nord |
| `dr.sued` | Arzt/Ärztin | Demo-Zentrum Süd (ohne Science-Freigabe) |
| `daten` | Datenmanagement (Migration, Exportantrag) | zentral + Nord + Süd |
| `redaktion` / `freigabe` | Formularredaktion / Formularfreigabe (Vier-Augen-Prinzip) | – |
| `forschung` | Forschung (nur Exportantrag) | – |
| `technik` | Technischer Betrieb (keine fachlichen Rechte) | – |

### Demonstrationsweg (ca. 10 Minuten)

1. Als `dr.nord` anmelden → **Fall anlegen** (3 Schritte). Für die kombinierte Strecke: Eingriffe „5-781“ und „Zelltransplantation“
   wählen (Module Knorpel + Osteotomie werden vorgeschlagen), Modus *DART Science*, Register DEKOR und KnorpelRegister.
2. Auf der Fallseite sind Link und Zugangscode für die **persönliche Einladung vor Ort** sichtbar (nur einmal angezeigt).
   Den Link in einem anderen Browser (oder mobil) öffnen → „Zugang jetzt öffnen“ → Zugangscode → Information lesen →
   **aktiv** zustimmen (nichts vorausgewählt) → zeichnen oder Namen eintippen → bestätigen.
3. Zurück im Fall: Status „Aktiv“, Zeitachse geplant, Bögen angelegt (Basis einmal, Knorpel, Osteotomie). Arztbogen öffnen:
   Modulchips, Fortschritt, Autosave („Wird gespeichert“, „Gespeichert“, „Nicht gespeichert“), Verzweigungen.
4. Patientenportal: Erstbefragung ausfüllen. Mailpit zeigt die automatische Einladung des Workers (nur mit Kontakt-Einwilligung und E-Mail).
5. Weitere Rollen: `doku.nord` (Papierupload), `dr.nord` → **Nachweise prüfen**, `redaktion`/`freigabe` → **Formulare**,
   `daten` → **Migration** (synthetische Beispieldatei), `forschung` + `admin` → **Auswertung & Export**.
6. Als `dr.nord` → **Auswertung & Export** → **Autoreport**: eigene Fälle gegenüber Zentrum und Gesamtkollektiv
   (IKDC/KOOS nach Pathologie, Eingriff, Modus; Verlauf; Patientencharakteristika). Die 300 synthetischen Demofälle lädt der
   Migrationsschritt automatisch (`DEMO_DATEN=false` schaltet das ab; in Produktion verweigert).
7. Als `doku.nord` oder `leitung.nord` → **Versand**: Dead Letters, unklare Zustellungen und gesperrte Kontakte bearbeiten
   (Pflichtgrund, protokolliert). `admin` sieht nur Anzahlen je Zentrum. Im Patientenportal lassen sich E-Mail-Erinnerungen
   abbestellen, ohne die Einwilligung zu berühren.
8. Als `redaktion` → **Formulare** → Version öffnen: wiederholbare Gruppen anlegen, Verzweigungen mit dem Assistenten
   bauen (Klartext und Live-Vorschau), bei Version > 1 **Mit Vorgängerversion vergleichen** (kritische Änderungen markiert).

### Daten zurücksetzen

```bash
docker compose down -v
```

Danach erneut `docker compose up --build`. `-v` löscht **alle** lokalen Volumes (Datenbanken, Objektspeicher).

### Anmeldung über Keycloak (OIDC) testen

```bash
AUTH_MODE=oidc docker compose --profile oidc up --build
```

Anmeldung mit `dr.nord` / `Demo-Passwort-1` (alle Demo-Konten haben dieses Passwort; nur lokal). Die Realm-Konfiguration liegt in
`infra/keycloak/dart-realm.json`. MFA (TOTP) ist im Realm vorbereitet, für die lokale Demo aber nicht erzwungen (siehe ADR-0005).

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| `docker compose up` bricht beim Image-Download ab (Rate-Limit) | `IMAGE_MIRROR=mirror.gcr.io docker compose up --build` |
| Build scheitert mit `SELF_SIGNED_CERT_IN_CHAIN` (Firmen-Proxy) | CA-Datei ins Projekt kopieren und `EXTRA_CA_CERT=./pfad/ca.crt docker compose up --build` |
| Port 3000/4000/8025 belegt | anderen Dienst beenden oder Portzuordnung in `docker-compose.yml` ändern |
| Anmeldung zeigt „Unbekannter Demo-Nutzer“ | Seed lief nicht: `docker compose logs migrate` |
| Keine E-Mails in Mailpit | Fall braucht Einwilligung mit „Kontaktaufnahme per E-Mail“ und eine E-Mail-Adresse; `docker compose logs worker` |
| „Produktionsstart verweigert …“ | gewollt: `NODE_ENV=production` mit Demo-Geheimnissen oder Testadaptern wird blockiert |

Fehlermeldungen der Anwendung enthalten eine **Vorgangsnummer** (`request_id`), die in den Betriebslogs ohne Inhaltsdaten wiederzufinden ist.

## Entwicklung ohne Docker

```bash
pnpm install
pnpm build
```

Datenbanken (PostgreSQL 18) und Mailpit z. B. per Docker starten, Rollen mit `infra/postgres/*.sh` anlegen, dann
`node migrations/migrate.mjs core|vault`, `node apps/api/dist/seed.js` und die Dienste `apps/vault`, `apps/api`, `apps/worker`
(`node dist/main.js`) sowie `apps/web` (`next start`) mit den Variablen aus `.env.example` starten.

## Tests

| Ebene | Befehl | Inhalt |
|---|---|---|
| Fachlogik (ohne Infrastruktur) | `pnpm test:unit` | Regel-DSL, Formularauswertung, Demonstrationsscore, Follow-up-Kalender (Monatsende, Sommerzeit), Einwilligungsautomat, CSV-Formelinjektion, Migration, Kontraste |
| API (laufende DB, Vault, API) | `pnpm test:api` | T02-Abnahmefälle 1–9, T03-Migration, CSRF, Idempotenz, Datumskorrektur, Linkablauf |
| Worker | `pnpm --filter @dart/worker test` | T02-10 Versand-Retry/Abgleich, Dead Letter, Consent vor Versand, Export |
| Browser (laufende Anwendung) | `pnpm test:e2e` | U03-Ansichten, 360 px, Tastatur, Konflikt, Papierweg, Screenshots |

Die Testumgebungsvariablen stehen in `docs/testbericht.md`. Ergebnisse: **docs/testbericht.md**.

## Struktur

```
apps/web        Next.js-Webanwendung (Personal + Patientenportal), Proxy zur API
apps/api        NestJS-API (modularer Monolith), REST v1, OpenAPI
apps/vault      Identity Vault (eigene DB, eigene Schlüssel, Dokumente im S3-Speicher)
apps/worker     Outbox-Versand, Erinnerungen, Exporte
packages/forms  Formularschema, Regel-DSL, Auswertung, Scores (Client und Server identisch)
packages/domain Einwilligung, Follow-up, Rollen, Katalog, CSV, Migration
packages/contracts  API-Verträge (zod) und deutsche Fehlercodes
packages/ui     Design-Tokens und Kontrastprüfung
migrations/     SQL-Migrationen (core, vault) und Läufer
infra/          Datenbank-Init, Keycloak-Realm, S3-Konfiguration
tests/          E2E (Playwright) und synthetische Fixtures
docs/           ADR, Entscheidungen, Traceability, Testbericht, Screenshots, Betrieb, Datenschutz
tools/          Quelleninventar, Variablenkatalog (Python/openpyxl), Restore-Probe
```

## Dokumentation

- [Architektur und Datenmodell](docs/architektur.md) · [ADR](docs/adr/) · [Rollenmatrix](docs/rollenmatrix.md)
- [Offene Fachfragen und Entscheidungen](docs/entscheidungen.md) · [Traceability F/M/D/U/T](docs/traceability.md)
- [Testbericht](docs/testbericht.md) · [Screenshots](docs/screenshots/README.md) · [Mapping-/Reconciliation-Bericht](docs/mapping-reconciliation-bericht.md)
- [Quellenanalyse Q02/Q03](docs/quellenanalyse.md) · [Neuanlage-Zuordnung](docs/neuanlage-zuordnung.md) · [Quellenmanifest](docs/quellenmanifest.md) · [Design-Tokens](docs/design-tokens.md) · [Betrieb](docs/betrieb.md) · [Datenschutz](docs/datenschutz.md)
- [Priorisierte Restliste](docs/restliste.md) · [OpenAPI](docs/api/openapi.json)
