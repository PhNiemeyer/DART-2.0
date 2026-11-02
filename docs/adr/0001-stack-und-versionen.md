# ADR-0001: Technologiestack und Versionsstand

Status: angenommen (Prototyp) · Datum: 02.11.2026

## Kontext
Der Masterprompt empfiehlt ein TypeScript-Monorepo mit Next.js, NestJS, PostgreSQL 18, separatem Vault, S3-kompatiblem Speicher,
Keycloak/OIDC, PostgreSQL-Outbox und getrenntem Worker. Versionen sollen beim Start verifiziert, stabil und in Lockdateien fixiert sein.

## Entscheidung
Stack wie empfohlen umgesetzt. Am 02.11.2026 geprüfte Versionen (npm-Registry), fixiert in `pnpm-lock.yaml`:

| Komponente | Version | Begründung |
|---|---|---|
| Node.js | 22 (LTS) | Laufzeit in Containern `node:22-alpine` |
| TypeScript | 5.9.3 | TS 7.0 (nativer Compiler) ist aktuell „latest“; NestJS benötigt `emitDecoratorMetadata`. 5.9 ist die stabile Linie mit bekannter Kompatibilität. |
| NestJS | 11.2.8 (dist-tag `legacy`) | 12.x ist seit 08/2026 aktuell; 11 wird weiter gepflegt und ist mit TS 5.9 und Swagger 11 erprobt. Upgrade auf 12 ist Restlistenpunkt R-12. |
| Next.js / React | 16.4.4 / 19.3.1 | aktuelle stabile Versionen |
| PostgreSQL | 18 (Container) | wie empfohlen; lokale Entwicklungstests liefen ebenfalls gegen 18 |
| Keycloak | 26.4 | stabile Linie |
| Vitest | 3.2.7 (dist-tag `V3`) | gepflegte Linie, kompatibel mit TS 5.9 |
| Playwright | 1.63.0 | entspricht dem in der Umgebung vorinstallierten Browser |
| nodemailer | 7.0.13 | Typdefinitionen passend verfügbar |
| zod | 4.6.7 | stabil |

Keine Vorabversionen. Abweichungen von „latest“ sind oben begründet (keine gleichwertige Alternative zum Stack, nur Versionswahl).

## Konsequenzen
Regelmäßige Sicherheitsupdates (siehe `docs/betrieb.md`). Major-Upgrades (NestJS 12, TS 7, Vitest 5) als eigene Arbeitspakete.
