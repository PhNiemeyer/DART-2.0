# Datenschutz – Liefergegenstände vor dem Pilot (Gliederung)

> Diese Seite ist **kein** Datenschutzkonzept und kein „DSGVO-konform“-Siegel. Sie strukturiert die Unterlagen, die Verantwortliche,
> Datenschutz und Ethik vor dem Pilot erstellen und freigeben müssen (D01–D03). Pseudonymisierung ist keine Anonymisierung.

## D01 Zweck- und Rechtsgrundlagenmatrix (Vorlage)

| Verarbeitung | Datenkategorien | Zweck | Rechtsgrundlage Art. 6 / Art. 9 DSGVO | Verantwortlich | Auftragsverarbeiter | Freigabe |
|---|---|---|---|---|---|---|
| Registerdokumentation Basic | pseudonyme Gesundheitsdaten | Qualitätssicherung/Register | offen | offen | Hosting | offen |
| Science-Auswertung | pseudonyme Gesundheitsdaten | Forschung | offen (Einwilligung?) | offen | – | offen |
| Kontakt Verlaufsbefragung | E-Mail (Vault) | Follow-up | Einwilligung (Scope „kontakt_followup“) | offen | E-Mail-Versand | offen |
| Einwilligungsnachweis | Signaturbild/Name, Dokument | Nachweis | offen | offen | Objektspeicher | offen |
| Identitätsverwaltung | Name, ggf. Geburtsdatum | Zuordnung | offen | offen | – | offen |

Weitere Liefergegenstände: Verzeichnis von Verarbeitungstätigkeiten, Datenschutz-Folgenabschätzung, Verträge (AVV, ggf. gemeinsame
Verantwortlichkeit der Zentren), Betroffeneninformation, Bewertung der Änderungen gegenüber 2017/2020 (Signaturspeicherung, Identitätsmodell, Hosting).

## D02 Technische und organisatorische Maßnahmen (Stand Prototyp)

Umgesetzt: getrennter Identity Vault mit eigener DB und eigenen Schlüsseln, feldweise AES-256-GCM, gehashte Zugangscodes (scrypt) und Tokens (SHA-256),
RLS mit FORCE und Laufzeitrolle ohne BYPASSRLS, Rollenprüfung je Objekt, Audit append-only, Rate Limits, CSRF-Schutz, CSP, no-store,
keine Gesundheitsdaten in URLs, keine IP-Speicherung in Fachdaten, keine Inhalte in Betriebslogs, Upload-Prüfung, Startsperren für Demo-Konfiguration.
Offen: TLS/Reverse Proxy, KMS/HSM und Schlüsselrotation, MFA-Pflicht, mTLS zwischen Diensten, produktiver Malwarescanner, Penetrationstest.
Keine Altverfahren (MD5, Triple-DES) übernommen.

## D03 Lösch- und Aufbewahrungsmatrix (Vorlage)

| Datenklasse | Speicherort | Frist (vom Verantwortlichen festzulegen) | Backups | Exportkopien | Nach Widerruf |
|---|---|---|---|---|---|
| Identität/Kontakt | Vault-DB | offen | offen | nie im Export | offen (E-07) |
| Einwilligungsnachweise | Vault + S3 | offen | offen | – | Nachweis des Widerrufs aufbewahren? offen |
| Pseudonyme Registerdaten | Kern-DB | offen | offen | Exportkopien beim Empfänger | offen |
| Audit | Kern-DB | offen | offen | – | – |
| Versandjournal | Kern-DB | offen | offen | – | – |
| Rohhistorie Migration | Schema legacy | offen | offen | – | offen |

Betroffenenrechte: Bearbeitung im Zentrum unter „Betroffenenrechte“ (ADR-0013) mit Frist (ein Monat, einmal verlängerbar),
Pflicht-Identitätsprüfung, Auskunftsentwurf, Einschränkung (sperrt Versand, Exporte, Auswertungen) und vorbereiteter Löschung;
die endgültige Löschung bleibt bis zur Freigabe der Matrix ein manueller, protokollierter Schritt (E-07, R-29). Sicherheitsvorfälle: Prozess mit Bewertung, Eskalation und Prüfung der 72-h-Meldefrist ist zu definieren.
