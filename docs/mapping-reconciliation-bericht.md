# Mapping- und Reconciliation-Bericht (synthetischer Probelauf)

> Grundlage: **synthetische** Quelle `tests/fixtures/altexport-synthetisch-CA.csv` (Quellsystem `DART-ALT-SYNTH`, Exportversion `SYNTH-1`)
> und die **synthetische** Mappingversion `MAP-DART-ALT-SYNTH` V1 (Status „Vorschlag“). Die Originalquellen Q02 (Variablenklassifikation,
> 1.441 Katalogzeilen) und Q03 (Datenbankbeschreibung V05, erwarteter SHA-256 `23b554ad…cb9b`) liegen **nicht** vor.
> Dieser Bericht belegt das Verfahren, nicht die Migration realer Bestände. Er wird mit `/migration` → „Reconciliation-Bericht“ erzeugt.

## Bilanz (Zeilen)

| geliefert | normalisiert | bewusst historisch archiviert | gesichert, ungeklärt | Quarantäne | ausgeglichen |
|---|---|---|---|---|---|
| 7 | 5 | 0 | 2 | 0 | ja |

Werte: 7 Zeilen × 13 Spalten = 91 Zellen geliefert und 91 erfasst. Jede Zelle hat genau ein Ergebnis (normalisiert, archiviert oder ungeklärt)
und einen Vergleichbarkeitsstatus (direkt, transformiert, nicht vergleichbar, ungeklärt).
Rohwert-Nachweis: 7 von 7 Datensätzen mit korrekter SHA-256 über den unveränderten Rohwert; 0 verwaiste Werte.
Idempotenz: zweiter Import desselben Batches → 0 neu, 7 bereits vorhanden. Rollback entfernt 7 Datensätze; Wiederimport danach → 7 neu.

## Klärungsliste (Auszug, alle Fälle aus dem Lastenheft nachgebildet)

| Code | Bedeutung | Behandlung |
|---|---|---|
| `PID_IST_BELEG_ID` | P_ID ist CRF-/Receipt-ID | als Beleg-ID gespeichert, **keine** Patientenzusammenführung |
| `ZENTRUM_999` | vorbelegter Zentrumscode | Zeile „gesichert, ungeklärt“; kein Zentrum vorgetäuscht |
| `VISITCODE_UNBEKANNT` | Code 7 nicht in der Codeliste | Zeile „gesichert, ungeklärt“ |
| (Visitcode 8) | laut Codeliste FU3 | als FU3 normalisiert; Sortierung nach Codeliste, nicht numerisch |
| `CHECKBOX_LEER` | leere Checkbox | **nicht** als Nein/0; Rohwert leer, Ergebnis ungeklärt („0“ wird dagegen „nein“) |
| `ALIAS_ABWEICHUNG` | Spalte `CA_VAS` = SAS-Alias von `SCHMERZ_VAS` | beide Namen bekannt, explizit zugeordnet |
| `VARID_MEHRFACH` | `CA_012` für zwei Spalten | keine Zuordnung ohne Kontext und Freigabe |
| `VARID_FEHLT` | Spalte ohne VARID | zusammengesetzter Quellschlüssel `CA:FREITEXT_ALT`, ungeklärt |
| `DATUM_UNPLAUSIBEL` | 24.04.3023 | OP-Datum nicht übernommen, Rohwert erhalten |
| `OPS_KONZEPT_MEHRDEUTIG` | 5-812 ohne Konzeptangabe | nicht normalisiert; mit Angabe G/T → Knorpelglättung bzw. Meniskusteilresektion |
| `SPALTE_UNGEMAPPT` | z. B. umbenanntes `FU_ERNEUTOP` statt `FU_ERNEUTOP_YN` | Rohwert gesichert, ungeklärt |
| (Klasse C) | `ALT_SCORE_ORIG` | nur historisch archiviert, „nicht vergleichbar“ |
| `EXPORTVERSION_UNBEKANNT` | unbekannte Exportversion | ganze Zeile in Quarantäne (gesichert, nicht normalisiert) |

Formelartige Altwerte (z. B. `=SUMME(A1)`) bleiben als Rohwert unverändert; im Forschungsexport werden sie entschärft.

## Für die echte Migration noch erforderlich

1. Lieferung Q02/Q03 und aller Registerbestände (E-12); Hash-Prüfung mit `pnpm quellen`.
2. Freigegebenes Mapping für alle B-Fälle und C-Werte (E-11), je Eintrag mit Quellzeile, Zielkonzept, Regel und Freigabe.
3. Mindestens zwei Probeläufe mit vollständigem Export, Reconciliation je Quelltabelle, Zentrum, Fall, Zeitpunkt, Variable inkl.
   Scorestichproben und Anhang-Hashes; danach Cutover mit Schreibstopp/Delta, finalem Abgleich, Freigabe und Rückfallplan.
4. Bestätigte Personenverknüpfung (`legacy_key_map`) – nie automatisch über P_ID, Patientennummer oder OP-Datum.
