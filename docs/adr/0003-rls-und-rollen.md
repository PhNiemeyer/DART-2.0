# ADR-0003: Rechteprüfung in API und PostgreSQL-RLS

Status: angenommen · Datum: 02.11.2026

## Entscheidung
- Jede API prüft Rolle, Zentrum und Objekt serverseitig (`apps/api/src/core/auth.ts`, `caseForActor`). Fremde Objekte liefern 404 (keine Existenzpreisgabe).
- **FORCE ROW LEVEL SECURITY** auf allen zentrumsbezogenen Fachtabellen. Laufzeitrolle `dart_app` ist weder Owner noch Superuser und hat kein BYPASSRLS.
  Der RLS-Kontext (`app.center_ids`, `app.patient_id`) wird transaktionslokal gesetzt; ohne Kontext sind keine Zeilen sichtbar.
- Patientensitzungen sind zusätzlich durch restriktive Policies auf den eigenen Patienten begrenzt (`005_patient_rls.sql`).
- Getrennte Rollen: `dart_worker` (Versand/Export, minimale GRANTs), `dart_migration` (nur Schema `legacy`), `dart_owner` (Migration/Seed, BYPASSRLS, nicht zur Laufzeit).
- Audit (`audit_event`) ist append-only (Trigger + nur INSERT-Recht).
- Zwei SECURITY-DEFINER-Funktionen (`portal_find_invitation`, `portal_find_session`) erlauben das Nachschlagen eines Token-Hashes ohne Zentrumskontext und liefern nur Zuordnungsdaten.

## Konsequenzen
Negative Tests (T02-1) prüfen fremde Zentren, manipulierte IDs, Downloads, Namenssuche und RLS direkt in der Datenbank.
Der Worker verarbeitet zentrumsübergreifend (Policy `worker_all`) – bewusst, mit minimalen Spalten-/Tabellenrechten.
Privilegierte, zeitlich begrenzte Sonderzugriffe (Break-Glass) sind noch nicht implementiert (Restliste R-07).
