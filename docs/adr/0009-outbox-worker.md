# ADR-0009: Transactional Outbox und getrennter Worker

Status: angenommen · Datum: 02.11.2026

- Einladungen/Erinnerungen werden in derselben Transaktion wie die fachliche Änderung als `outbox_message` mit
  Idempotenzschlüssel (Fall, Erhebungsereignis, Regelversion, Stufe) angelegt; Duplikate sind per UNIQUE ausgeschlossen.
- Der Worker beansprucht Nachrichten mit `FOR UPDATE SKIP LOCKED` und Lease, prüft **unmittelbar vor dem Versand** Einwilligung und
  Ereignisstatus, erzeugt einen neuen einmaligen Token (alte werden wirkungslos) und versendet per SMTP mit deterministischer Message-ID.
- Unklares Ergebnis (Zeitüberschreitung nach Übergabe) → Status „unklar“ → vor erneutem Versand Abgleich beim Anbieter (lokal: Mailpit-API).
- Fehler mit exponentiellem Backoff; nach 5 Versuchen Dead Letter. Versandjournal in `delivery_attempt`.
- Erinnerungen 7 und 12 Tage nach Einladung, Arzt-Erinnerung 3 Tage nach geplanter OP – **vorläufig**, fachlich freizugeben (E-06).
- Exporte laufen asynchron im Worker.
