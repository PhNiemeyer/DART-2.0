# Betrieb (Entwurf für Pilot-MVP)

> Prototyp: nur lokale Ausführung. Kein Live-Deployment wurde durchgeführt.

## Zielwerte (Vorschlag, nicht gemessen)
Pilot-SLO: 99,5 % monatliche Verfügbarkeit, RPO ≤ 24 h, RTO ≤ 8 h. Performance-Ziel: p95 Listen-/Speicher-API < 800 ms, Dashboard < 2,5 s
bei 100.000 Fällen und 100 aktiven Nutzern. **Ein Lasttest wurde nicht durchgeführt** (Restliste R-06).

## Umgebungen
Getrennte Entwicklungs-, Test- und Produktivumgebungen; EU/EWR-Hosting als Voreinstellung. TLS am Reverse Proxy (nicht Teil des Prototyps),
private Datenbanknetze (im Compose: `core` und `vault` getrennt, Datenbanken ohne Portfreigabe). Geheimnisse aus einem Secret-Manager,
niemals aus `.env.example`. Start verweigert bei Demo-Geheimnissen, `AUTH_MODE=dev`, Demo-Signatur-/Malwareadaptern, Mailpit, Testdatum.

## Release und Rollback
1. CI grün (Lint/Typprüfung, Unit, Migrationstest, API-/E2E-Tests, Abhängigkeitsprüfung).
2. Datenbanksicherung beider Datenbanken und des Objektspeichers.
3. Migrationen sind vorwärtsgerichtet und prüfsummengesichert (`migrations/migrate.mjs`); veränderte, bereits eingespielte Dateien werden abgelehnt.
4. Rollback: vorheriges Image ausrollen; bei inkompatibler Migration Restore aus Schritt 2 und Wiederanwenden von Widerrufs-/Löschereignissen seit der Sicherung.

## Sicherung und Wiederherstellung
- `pg_dump -Fc` für `dart` und `dart_vault` (getrennte Schlüssel und Ablageorte), Objektspeicher mit Versionierung.
- Restore-Probe regelmäßig: `tools/backup-restore-probe.sh` (lokal bestanden, siehe Testbericht).
- Nach jedem Restore: Widerrufe, Sperren und Löschentscheidungen aus dem Audit seit dem Sicherungszeitpunkt erneut anwenden.

## Überwachung und Alarmierung
- Healthchecks: `/api/health` (DB + Vault), Vault `/health`, Worker `/health` (letzter Lauf/Fehler), Web `/anmelden`.
- Kennzahlen (Vorschlag): Outbox-Rückstau, Anzahl `unklar`/`dead_letter`, Fehlerquote 5xx, Latenzen, Anmeldefehler, Rate-Limit-Treffer.
- Betriebslogs sind JSON und datensparsam (keine Bodies, Tokens, Signaturen, Freitexte; Fehler mit `request_id`).

## Sicherheitsupdates
Monatliche Abhängigkeitsprüfung (`pnpm audit`, Image-Scan), sofortige Updates bei kritischen Lücken, Major-Upgrades geplant (ADR-0001).

## Exit-Export
Vollständiger Export aller Daten über die Datenbanksicherungen beider Datenbanken plus Objektspeicher; fachlich lesbare Exporte über das Exportmodul
(Datenwörterbuch, Versionen, Prüfsummen).

## Verantwortungsplan (zu besetzen)
Betriebsverantwortung, Datenbankadministration, Sicherheitsverantwortung, Rufbereitschaft, Ansprechpartner Datenschutz, Freigabe von Releases.
