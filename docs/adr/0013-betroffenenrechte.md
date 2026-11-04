# ADR-0013: Betroffenenrechte – Bearbeitung im Zentrum, Fristen, vorbereitete Löschung

Status: angenommen (Prototyp) · Datum: 04.11.2026

## Kontext

Lastenheft D03: Auskunft, Berichtigung, Einschränkung, Widerruf und Löschung mit Zuständigkeit und Fristen bearbeitbar machen;
„Benannte Bearbeitungsstelle mit Identitätsprüfung“. Der Umgang mit Daten nach Widerruf bzw. Löschung ist rechtlich offen (E-07).

## Entscheidung

- **Zuständigkeit** (Entscheidung des Auftraggebers, 04.11.2026): Das Zentrum bearbeitet. Dokumentation und Zentrumsverantwortliche
  erfassen Anträge im Fall (`dsr.record`), nur Zentrumsverantwortliche prüfen, bearbeiten und schließen ab (`dsr.manage`).
  Die zentrale Administration sieht über `dsr_overview()` nur Anzahlen je Zentrum, Art und Frist (`dsr.overview`).
- **Frist**: ein Monat ab Eingang, einmal um zwei Monate verlängerbar – nur innerhalb der Frist und mit Begründung
  (Art. 12 Abs. 3 DSGVO; als Vorschlag ausgewiesen, Bestätigung E-20). Überfällige Anträge stehen in Liste und Kennzahl.
- **Identitätsprüfung** ist Pflicht vor jeder inhaltlichen Bearbeitung (Auskunft, Einschränkung, Abschluss als „erledigt“).
  Verfahren: persönlich mit Ausweis, Portal mit Zugangscode, schriftlich mit Unterschriftenabgleich, Rückruf unter bekannter Nummer.
  Ein E-Mail-Link allein reicht nicht (Lastenheft F14).
- **Auskunft**: Zusammenstellung aus Kern und Vault (Identität, Fälle, Einwilligungen, Bögen mit Antworten und Scores, Kontakt,
  Versand, Anzahl protokollierter Zugriffe) als druckbarer Entwurf; Zwecke, Empfänger und Speicherdauer stammen aus dem
  freigegebenen Informationstext (offen, E-07/E-08). Abruf ist protokolliert.
- **Einschränkung** (`patient.restricted_at`): sperrt sofort Einladungen (Outbox storniert, Links widerrufen), Exporte und
  Auswertungen (Autoreport-Funktionen und Export schließen die Person aus). Aufhebung mit Begründung.
- **Löschung**: vorbereitet, nicht ausgeführt (Entscheidung des Auftraggebers). Sofortsperre über die Einschränkung,
  Übersicht je Datenklasse (Vault, Einwilligungen, Fälle, Antworten, Scores, Versand, Exporte, Audit, Backups) mit
  Vorschlägen, alle Entscheidungen „offen“. Abschluss als „erledigt“ nur mit Bestätigung, dass die Löschung nach freigegebener
  Matrix manuell durchgeführt wurde.
- **Verlauf** je Antrag in `data_subject_request_event`, nur anhängen (Trigger), zusätzlich Fachaudit.

## Folgen

- Eine automatisierte, nachweisbare Löschung bzw. Anonymisierung folgt nach Freigabe der Lösch-/Aufbewahrungsmatrix (R-29).
- Die Mitteilung an die Person (Auskunft, Verlängerung, Ergebnis) erfolgt außerhalb des Systems; der Inhalt wird im Ergebnis dokumentiert.
