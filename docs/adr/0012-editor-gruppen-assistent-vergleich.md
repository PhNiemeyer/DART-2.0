# ADR-0012: Editor – wiederholbare Gruppen, Verzweigungsassistent, Versionsvergleich

Status: angenommen (Prototyp) · Datum: 04.11.2026

## Kontext

Die Formularredaktion konnte Gruppen nur per JSON pflegen und Verzweigungen nur als Regel-DSL eintippen.
Vor einer Freigabe fehlte eine Übersicht, was sich gegenüber der Vorversion ändert.

## Entscheidung

- **Gruppen** werden im Editor gepflegt: Bezeichnung, Eintragsbezeichnung, Mindest- und Höchstanzahl, Sichtbarkeit und Felder
  der Gruppe. Verschachtelte Gruppen bleiben ausgeschlossen (Schemaprüfung).
- **Verzweigungsassistent** (`packages/forms/src/builder.ts`): Bedingungen aus Feld, Operator und Wert, verknüpft mit „und“
  oder „oder“. Der Assistent erzeugt ausschließlich Whitelist-Operatoren der bestehenden Regel-DSL; Regeln, die er nicht
  darstellen kann, bleiben unverändert und sind nur als JSON bearbeitbar. Wählbar sind Felder außerhalb von Gruppen und
  innerhalb einer Gruppe die Geschwisterfelder derselben Instanz – entsprechend der Auswertungslogik der Engine.
  Jede Regel wird zusätzlich als deutscher Klartext angezeigt.
- **Gruppensichtbarkeit**: Die Engine liefert `visibleGroups`; Formulare zeigen Gruppen nur, wenn deren Regel erfüllt ist
  (vorher wurden nur die Gruppenfelder ausgeblendet, die Gruppe selbst blieb sichtbar).
- **Versionsvergleich** (`packages/forms/src/diff.ts`, `GET /api/v1/form-versions/:id/diff`): Vergleich über stabile Item-IDs
  mit Standardbasis Vorgängerversion. „Kritisch“ sind Änderungen, die die Vergleichbarkeit über Versionen betreffen:
  Datentyp, Variablenkennung, Einheit, entfernte Codes oder Felder, engerer Wertebereich, neues Pflichtfeld, kleinere
  Höchstanzahl einer Gruppe, Berechnung. Alles andere ist ein Hinweis.

## Folgen

- Fachliche Inhalte bleiben Beispiele und benötigen weiterhin die Vier-Augen-Freigabe (E-01).
- Der Vergleich ist beschreibend; ein verpflichtender Änderungsvermerk für kritische Änderungen vor der Prüfung ist offen (R-28).
