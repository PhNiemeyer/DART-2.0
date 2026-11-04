# ADR-0011: Versand-Leitstand und E-Mail-Abmeldung

Status: angenommen (Prototyp) · Datum: 04.11.2026

## Kontext

Lastenheft F17: Versandjournal und Dead-Letter-Bearbeitung; „Zustellfehler und Abmeldungen bearbeitbar“. Bei unklarem
Provider-Ergebnis darf nicht blind doppelt gesendet werden.

## Entscheidung

- **Rollen** (Entscheidung des Auftraggebers, 03.11.2026): Zentrumsverantwortliche und Dokumentation bearbeiten Versandfehler
  im eigenen Zentrum (`dispatch.manage`, RLS). Die zentrale Administration sieht über `dispatch_overview()` nur Anzahlen je
  Zentrum und Status, ohne Fall- oder Patientenbezug (`dispatch.overview`).
- **Aktionen**, jeweils mit Pflichtgrund und Audit:
  - *Erneut einreihen* (Dead Letter, fehlgeschlagen, storniert): dieselbe Nachricht, derselbe Idempotenzschlüssel. Das
    Versuchsbudget `max_attempts` steigt um 5; Versuchsnummern im Journal laufen weiter. Die Einwilligung wird vor dem Versand
    erneut geprüft. Gesperrt, solange der Kontakt abgemeldet oder unzustellbar ist.
  - *Abgleich anfordern* (unklar): Der Worker fragt beim Anbieter über die Message-ID nach, bevor er sendet.
  - *Stornieren* (ausstehend, fehlgeschlagen, unklar, Dead Letter).
- **Kontaktstatus** `contact_preference` je Patient (aktiv/abgemeldet/unzustellbar) betrifft nur den E-Mail-Kanal;
  Einwilligung und Befragungen bleiben unberührt.
  - Abmeldung im Patientenportal (nach Anmeldung) und durch das Zentrum (Entscheidung des Auftraggebers). Kein
    Ein-Klick-Abmeldelink in der E-Mail (Linkscanner); die E-Mail nennt den Weg.
  - Weist der Mailserver die Empfängeradresse dauerhaft ab (SMTP 550/551/553), setzt der Worker die Nachricht sofort auf Dead
    Letter und den Kontakt auf „unzustellbar“. Reaktivieren darf nur das Zentrum, mit Bestätigung der Adressprüfung.
  - Der Worker prüft den Kontaktstatus unmittelbar vor dem Versand und storniert mit Grund.
- Im Leitstand erscheinen weder E-Mail-Adressen noch Inhalte, nur Fallnummer, Pseudonym, Zeitpunkt und Fehlercodes.

## Folgen

- Korrektur der E-Mail-Adresse selbst erfolgt weiterhin über die Identitätsdaten im Vault; der Leitstand verlinkt auf den Fall.
- Produktiv ist eine Bounce-Verarbeitung des Anbieters (asynchrone Rückläufer, Webhook) anzubinden (R-27).
