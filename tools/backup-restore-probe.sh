#!/bin/sh
# Restore-Probe (T04/D03): Sicherung der Kerndatenbank, Wiederherstellung in eine frische Datenbank,
# Vergleich der Zeilenzahlen. Nur für lokale/synthetische Umgebungen.
# Aufruf: tools/backup-restore-probe.sh <SUPERUSER_URL_OHNE_DB> (z. B. postgres://postgres:pw@localhost:55432)
set -eu
BASE="$1"
DUMP=$(mktemp)
TABLES="patient treatment_case consent_record response answer response_revision audit_event outbox_message"
count() { for t in $TABLES; do printf "%s=%s " "$t" "$(psql -tA "$1" -c "SELECT count(*) FROM $t")"; done; }
pg_dump -Fc "$BASE/dart" > "$DUMP"
psql -q "$BASE/postgres" -c "DROP DATABASE IF EXISTS dart_restore_probe" -c "CREATE DATABASE dart_restore_probe"
pg_restore --exit-on-error -d "$BASE/dart_restore_probe" "$DUMP"
A=$(count "$BASE/dart")
B=$(count "$BASE/dart_restore_probe")
echo "Quelle:          $A"
echo "Wiederhergestellt: $B"
psql -q "$BASE/postgres" -c "DROP DATABASE dart_restore_probe"
rm -f "$DUMP"
if [ "$A" = "$B" ]; then echo "RESTORE-PROBE: BESTANDEN (Zeilenzahlen identisch)"; else echo "RESTORE-PROBE: FEHLGESCHLAGEN"; exit 1; fi
echo "Hinweis: Nach einem echten Restore sind Widerrufs-/Löschereignisse erneut anzuwenden (docs/betrieb.md)."
