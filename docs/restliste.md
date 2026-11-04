# Priorisierte Restliste

P1 = vor Pilot-MVP erforderlich, P2 = Ausbau. Fachliche Freigaben stehen in `docs/entscheidungen.md`.

| Nr. | Prio | Thema | Beschreibung |
|---|---|---|---|
| R-01 | P1 | Fachliche Inhalte | Freigegebene Bögen, Matrix, Scores (E-01, E-02, E-09) einpflegen; Demonstrationsinhalte entfernen |
| R-02 | P1 | MFA | TOTP/WebAuthn im Keycloak-Realm als Pflicht; Sitzungsdauer/Abmeldung abstimmen |
| R-03 | P1 | Schlüssel | KMS/HSM für Vault-Schlüssel, Rotation (Wiederverschlüsselung), mTLS zwischen API/Worker und Vault |
| R-04 | P1 | Malwareprüfung | Produktiven Scanner (z. B. ClamAV) als Adapter anbinden; Quarantäne-Ablage |
| R-05 | P1 | Reverse Proxy/TLS | TLS, HSTS, Security-Header am Proxy; Hosting EU/EWR (E-08) |
| R-06 | P1 | Lasttest | 100.000 synthetische Fälle, 100 Nutzer, p95-Messung; Indizes ggf. ergänzen |
| R-07 | P1 | Sonderzugriff | Zeitlich begrenzter, begründeter, auditierter Break-Glass-Zugriff |
| R-08 | P1 | Zentrumsverantwortliche | Antragsworkflow für Team- und Prozessänderungen |
| R-09 | P1 | Datenmanagement | Pseudonyme Qualitätsanfragen an Zentren (Anlegen, Beantworten, Schließen) |
| R-10 | P1 | Editor | Wiederholbare Gruppen, Verzweigungsassistent, Diff zwischen Versionen in der Oberfläche |
| R-11 | P1 | Zuordnungsmatrix | Pflege und Versionierung der Matrix in der Oberfläche statt Codedatei |
| R-12 | P2 | Upgrades | NestJS 12, TypeScript 7, Vitest 5 prüfen (ADR-0001) |
| R-13 | P1 | Originalscores | Historische Originalscores als `original_historisch` übernehmen, getrennt von Neuberechnung |
| R-14 | – | Versand-Leitstand | **Erledigt** (04.11.2026): `/versand` mit Dead Letters, unklaren Zustellungen, erneutem Einreihen, Storno, Abgleich; E-Mail-Abmeldung im Portal und durch das Zentrum (ADR-0011) |
| R-15 | P1 | Berichte | Autoreport (03.11.2026) mit automatisierten Tests (T05) und Kleingruppenunterdrückung; Zentrumsbericht `/auswertung` noch ohne automatisierten Nennertest |
| R-16 | P2 | Export Rohhistorie | Berechtigter Export der Migrations-Rohhistorie |
| R-17 | P1 | Migration | Originalexporte verschlüsselt ablegen, freigegebene Mappings (Katalog V05 liegt vor), zwei Probeläufe, Cutover-Plan (E-11, E-12) |
| R-18 | P1 | Barrierefreiheit | Vollständiger WCAG-2.2-AA-Audit inkl. Screenreader (NVDA/VoiceOver) |
| R-19 | P1 | Betroffenenrechte | Bearbeitungsoberfläche für Auskunft/Berichtigung/Einschränkung/Löschung mit Fristen |
| R-20 | – | Datumseingabe | **Erledigt** (03.11.2026): `DateInput` mit TT.MM.JJJJ, Prüfung auf Kalendergültigkeit und Grenzen, feldnahe Fehler |
| R-21 | P2 | Weitere Gelenke | Schulter, Hüfte, Sprunggelenk (Datenmodell vorbereitet, in der Anlage deaktiviert) |
| R-22 | P1 | CI | GitHub-Workflow ist angelegt, in dieser Umgebung aber nicht ausgeführt; im Ziel-Repository aktivieren und prüfen |
| R-23 | P1 | Penetrationstest | Externer Test vor Produktivfreigabe |
| R-24 | P2 | Mehrsprachigkeit | Neuanlage-Vorschlag 33 (language/translation_version): Übersetzungsversionen für Bögen und Oberfläche |
| R-26 | P1 | Benchmarking | Risikoadjustierung (Alter, BMI, Baseline-Score), Funnel-Plot, MCID-Anteile, Freigabe der Methodik (E-18) |
| R-27 | P1 | Rückläufer | Asynchrone Bounce-/Beschwerdemeldungen des produktiven Mailanbieters (Webhook) auf „unzustellbar“ abbilden |
| R-25 | P1 | Mapping-Freigabe | Oberfläche, um je Katalogzeile Zielkonzept, Regel und Freigabeperson zu erfassen (Vier-Augen), daraus neue Mappingversion erzeugen |
