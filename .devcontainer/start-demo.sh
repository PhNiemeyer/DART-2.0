#!/usr/bin/env bash
# Startet die DART-2.0-Demo im Codespace (synthetische Daten, Demo-Anmeldung, E-Mails nur ins Test-Postfach Mailpit).
set -euo pipefail
cd "$(dirname "$0")/.."

# Einladungslinks in E-Mails sollen auf die weitergeleitete Codespaces-Adresse zeigen
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  export PUBLIC_WEB_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi

# Docker-in-Docker braucht nach dem Start einen Moment
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

echo "DART 2.0: Demo wird gestartet. Der erste Start baut die Anwendung und dauert einige Minuten …"
docker compose up -d --build

echo "Warte auf die Webanwendung …"
for i in $(seq 1 120); do
  if curl -fs -o /dev/null http://localhost:3000/anmelden; then
    echo ""
    echo "============================================================"
    echo " DART 2.0 läuft (Prototyp, ausschließlich synthetische Daten)"
    echo " Webanwendung:    ${PUBLIC_WEB_URL:-http://localhost:3000}"
    echo " Test-Postfach:   Reiter „Ports“ → 8025 (Mailpit)"
    echo " Anmeldung:       Demo-Nutzer auswählen, z. B. dr.nord"
    echo "============================================================"
    exit 0
  fi
  sleep 5
done
echo "Die Webanwendung antwortet noch nicht. Status: docker compose ps · Protokoll: docker compose logs --tail 50 web api"
exit 1
