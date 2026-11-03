# ADR-0010: Autoreport mit Benchmarking gegen das Gesamtkollektiv

Status: angenommen (Prototyp) · Datum: 03.11.2026

## Kontext

Ärztinnen und Ärzte sollen ihre eigenen Fälle (Patientencharakteristika, Outcome IKDC/KOOS nach Diagnose/Pathologie)
sehen und mit dem Gesamtkollektiv aller Zentren vergleichen. Die Zentrumsgrenze (RLS) darf dafür nicht aufgeweicht werden:
Fremde Einzelfälle bleiben unsichtbar.

## Entscheidung

- **Eigene Daten** (Operateur, Zentrum) über `report_scores_raw` und `report_characteristics_raw` als `SECURITY INVOKER`:
  Die Funktionen laufen unter der Rolle `dart_app` mit RLS und den Zentren der Sitzung. Fremde Zentren liefern nichts.
- **Gesamtkollektiv** über `report_scores_gesamt` und `report_characteristics_gesamt` als `SECURITY DEFINER`:
  Sie geben ausschließlich Aggregate zurück (Gruppe, n, Mittelwert, SD bzw. Anzahl), keine Fall-IDs, keine Zentren.
  Bei n < 5 werden Mittelwert und Anzahl unterdrückt (E-15). Es gibt keinen Parameter zur Auswahl einzelner Zentren.
- Ebenen: Operateur (nur Rolle Arzt, verantwortliche Ärztin/Arzt am Fall) → Zentrum → Gesamtkollektiv (inkl. eigener Fälle).
- Gruppierung je Fall nach Modul (Pathologie), Eingriff, Erfassungsmodus oder Behandlungsart; Fälle mit mehreren Modulen
  erscheinen in mehreren Gruppen, „Alle Fälle“ zählt jeden Fall einmal.
- Score: jeweils letzte abgeschlossene Antwort je Fall und Zeitpunkt, `derived_score` der Formularengine; optional
  Veränderung zur Baseline (gepaarte Fälle).
- Einordnung: „über/unter Gesamtkollektiv“ nur, wenn das 95-%-Konfidenzintervall (t-Verteilung) des eigenen Mittelwerts den
  Gesamtmittelwert nicht einschließt; sonst „im Bereich“; bei n < 5 „zu wenige Fälle“. Beschreibend, **nicht risikoadjustiert**,
  keine Rangliste. Der Hinweis steht im Bericht, im CSV-Kopf und im Druck.
- Altersgruppe (5-Jahres-Klassen) wird bei Anlage aus dem Geburtsdatum berechnet und im Kern gespeichert; das Geburtsdatum
  bleibt im Vault. Geschlecht wird im Kern als Kategorie gespeichert (E-17).

## Folgen

- Kein Zugriff auf fremde Einzeldaten; die Gesamtfunktionen sind im RLS-Test (T05) auf Spalten und Kleingruppen geprüft.
- IKDC und KOOS sind aus V05 (Blätter IK/KO) abgeleitet und nach Scoring-Anleitung umgesetzt, aber mit Status
  „Freigabe ausstehend“ gekennzeichnet (E-09). Lizenzen sind ungeklärt.
- Risikoadjustierung (z. B. Alter, BMI, Baseline) und Funnel-Plots sind nicht umgesetzt (R-26).
