# Quellenanalyse Variablenkatalog Knie (Q02, Q03)

Erzeugt durch `pnpm katalog` (`tools/variablenkatalog.py`) aus den Originaldateien in `docs/quellen/`.
Die Analyse prüft Struktur und Kennzahlen. Sie trifft **keine** fachliche Entscheidung und erteilt **keine** Freigabe.

| Datei | SHA-256 |
|---|---|
| DART_2_Variablenklassifikation.xlsx | `0a333a5632762ceda5c355bfda62402fc506a9e57fec49147a4cd0e9a9ed0778` |
| PROD_DatabaseDescriptionPlan_DART_Knie_V05.xlsx | `23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b` |

## Abgleich mit dem Lastenheft

| Prüfung | Lastenheft | Gezählt | Ergebnis |
|---|---|---|---|
| SHA-256 V05 | `23b554addc04…` | `23b554addc04…` | stimmt |
| Katalogzeilen (Blatt Variablen) | 1441 | 1441 | stimmt |
| Übernahme | 753 | 753 | stimmt |
| Überarbeitung | 668 | 668 | stimmt |
| Entfall | 20 | 20 | stimmt |
| Neuanlage-Vorschläge | 33 | 33 | stimmt |
| Zeilen mit eingetragener Freigabeperson | 0 | 0 | stimmt |
| V05 Blätter | 24 | 24 | stimmt |
| V05 Variablenblätter | 21 | 21 | stimmt |
| Hinweis „eCRF-/SAS-Alias abweichend“ (Katalog) | 285 | 285 | stimmt |
| Alias abweichend (aus V05 neu berechnet) | 285 | 285 | stimmt |
| Hinweis „VARID fehlt“ (Katalog) | 34 | 34 | stimmt |
| VARID fehlt (aus V05 neu berechnet) | 34 | 34 | stimmt |
| Hinweis „VARID im Blatt mehrfach“ (Katalog) | 10 | 10 | stimmt |
| VARID mehrfach (aus V05 neu berechnet, Zeilen) | 10 | 10 | stimmt |
| Hinweis „Leere Checkbox nicht automatisch 0“ | 355 | 355 | stimmt |
| Katalogzeilen ohne passende V05-Quellzeile | 0 | 0 | stimmt |

Zeilen mit mindestens einem Prüfhinweis: 728; davon mit mehreren Hinweisen: 2 (Hinweise überlagern sich, die Zählwerte sind nicht addierbar).
Entscheidungsstatus: „Vorschlag; fachlich offen“ 1441.

## Katalogzeilen je Blatt

| Blatt | Zeilen | Übernahme | Überarbeitung | Entfall |
|---|---|---|---|---|
| CA | 352 | 0 | 339 | 13 |
| BA | 110 | 102 | 8 | 0 |
| ME | 48 | 37 | 10 | 1 |
| VK | 45 | 35 | 10 | 0 |
| PA | 39 | 31 | 8 | 0 |
| KN | 106 | 94 | 12 | 0 |
| MR | 46 | 38 | 8 | 0 |
| OS | 107 | 90 | 17 | 0 |
| EN | 82 | 68 | 14 | 0 |
| PS | 103 | 58 | 45 | 0 |
| PV | 118 | 51 | 67 | 0 |
| SY | 12 | 4 | 8 | 0 |
| DM | 75 | 57 | 15 | 3 |
| FU | 30 | 16 | 12 | 2 |
| EQ | 14 | 1 | 13 | 0 |
| KO | 50 | 40 | 10 | 0 |
| MA | 12 | 4 | 8 | 0 |
| IK | 28 | 2 | 25 | 1 |
| OX | 20 | 0 | 20 | 0 |
| FZ | 26 | 15 | 11 | 0 |
| VP | 18 | 10 | 8 | 0 |

## Basic/Science-Zuordnung laut Katalog

- Science laut CRF-Übersicht: 816
- Basic und Science (CA): 352
- Patientenmodul; Basic/Science-Zuordnung zu bestätigen: 273

## Prüfhinweise

| Hinweis | Zeilen |
|---|---|
| Leere Checkbox nicht automatisch 0 | 355 |
| eCRF-/SAS-Alias abweichend | 285 |
| VARID fehlt | 34 |
| Modulaktivierung CRF-Übersicht vs. IK!K2 abgleichen | 28 |
| In ddpjson nicht aufgeführt | 12 |
| VARID im Blatt mehrfach | 10 |
| IK-Präfix im FZ-Blatt | 3 |
| VARNAME im Blatt mehrfach | 2 |
| Vorgänger im Verlauf FU_ERNEUTOP_YN, im Blatt FU_ERNEUTOP | 1 |
| Datumsfehler 24.04.3023 | 1 |
| Versionsnachweis erforderlich | 1 |

## Abweichungen Katalog ↔ V05

Keine: alle Katalogzeilen verweisen auf die passende Quellzeile (Blatt, Zeile, Altname, VARID).

## V05-Blätter

- CRF page types (kein Variablenblatt)
- Version history (kein Variablenblatt)
- CA – 352 nicht leere Datenzeilen, davon 352 im Katalog
- BA – 110 nicht leere Datenzeilen, davon 110 im Katalog
- ME – 48 nicht leere Datenzeilen, davon 48 im Katalog
- VK – 45 nicht leere Datenzeilen, davon 45 im Katalog
- PA – 39 nicht leere Datenzeilen, davon 39 im Katalog
- KN – 106 nicht leere Datenzeilen, davon 106 im Katalog
- MR – 46 nicht leere Datenzeilen, davon 46 im Katalog
- OS – 107 nicht leere Datenzeilen, davon 107 im Katalog
- EN – 82 nicht leere Datenzeilen, davon 82 im Katalog
- PS – 103 nicht leere Datenzeilen, davon 103 im Katalog
- PV – 118 nicht leere Datenzeilen, davon 118 im Katalog
- SY – 12 nicht leere Datenzeilen, davon 12 im Katalog
- DM – 75 nicht leere Datenzeilen, davon 75 im Katalog
- FU – 30 nicht leere Datenzeilen, davon 30 im Katalog
- EQ – 14 nicht leere Datenzeilen, davon 14 im Katalog
- KO – 50 nicht leere Datenzeilen, davon 50 im Katalog
- MA – 12 nicht leere Datenzeilen, davon 12 im Katalog
- IK – 28 nicht leere Datenzeilen, davon 28 im Katalog
- OX – 20 nicht leere Datenzeilen, davon 20 im Katalog
- FZ – 26 nicht leere Datenzeilen, davon 26 im Katalog
- VP – 18 nicht leere Datenzeilen, davon 18 im Katalog
- ddpjson (kein Variablenblatt)
