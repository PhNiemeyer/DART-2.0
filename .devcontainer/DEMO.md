# DART 2.0 – Demo im Browser

**Prototyp mit ausschließlich synthetischen Daten. Bitte keine echten Patientendaten eingeben.**

1. Warten, bis im Terminal „DART 2.0 läuft“ erscheint (erster Start einige Minuten, danach deutlich schneller).
   Die Webanwendung öffnet sich automatisch; sonst unten den Reiter **Ports** öffnen und bei **3000** auf das Globus-Symbol klicken.
2. Einen Demo-Nutzer auswählen:

| Nutzer | Rolle | Gut für |
|---|---|---|
| `dr.nord` | Arzt/Ärztin, Zentrum Nord | Fall anlegen, Arztbogen, **Autoreport mit Benchmarking** |
| `leitung.nord` | Zentrumsverantwortliche/r | **Versand-Leitstand**, **Betroffenenrechte** |
| `doku.nord` | Dokumentation | Papierweg, Anträge erfassen |
| `redaktion` / `freigabe` | Formularredaktion / -freigabe | **Formulareditor**, Versionsvergleich, Vier-Augen-Freigabe |
| `daten` | Datenmanagement | Variablenkatalog V05, Migration |
| `admin` | Zentrale Administration | Konten, Export-Freigabe, Übersichten |

3. Einladungs-E-Mails landen im Test-Postfach **Mailpit** (Reiter **Ports** → 8025), nie bei echten Empfängern.

Es sind 300 synthetische Fälle vorhanden. Daten zurücksetzen: im Terminal `docker compose down -v && bash .devcontainer/start-demo.sh`.

Der Codespace stoppt nach 30 Minuten ohne Aktivität automatisch. Löschen unter https://github.com/codespaces.
