# ADR-0004: Versioniertes JSON-Formularschema mit deklarativer Regel-DSL

Status: angenommen · Datum: 02.11.2026

## Entscheidung
- Ein Formular ist eine `questionnaire_version` mit einem JSON-Schema (`packages/forms/src/types.ts`): Abschnitte, Items mit stabiler
  Item-ID und Variablenkennung (`varId`), deutschem Label, Hilfe, Typ, Einheit, Messmethode, Codes, Pflicht, Bereich, Nachkommastellen,
  zulässigen Fehlgründen, Verzweigung (`visibleIf`), Prüfregeln und wiederholbaren Gruppen.
- FormItem, BranchRuleVersion, ValidationRuleVersion und CodelistVersion sind **Teil dieses unveränderlichen, gehashten Schemas** statt
  eigener Tabellen. Bei Veröffentlichung werden `variable_concept` und `variable_definition_version` abgeleitet (Variablenkatalog).
- Regel-DSL mit Whitelist (`all, any, not, eq, in, exists, gt, gte, lt, lte`), **ohne eval**. Dieselbe Funktion (`evaluateForm`) läuft im Browser und auf dem Server.
- Vor der Prüfung: Schemavalidierung (Referenzen, Typen, Zyklen, Gruppen). Veröffentlichte Versionen sind per DB-Trigger unveränderlich.
- Ausgeblendete Antworten werden **nicht gelöscht**, sondern als `active=false` gespeichert und aus Pflichtprüfungen und Scores ausgeschlossen.
- Scores sind versionierte Algorithmen (`DEMO-SCORE@1`); im Prototyp ausschließlich ein ausdrücklich so benannter Demonstrationsscore.

## Konsequenzen
Neue medizinische Inhalte benötigen keinen Deploy; neue Feldtypen schon. Die Editor-Oberfläche pflegt einfache Felder strukturiert;
wiederholbare Gruppen werden im Prototyp per JSON-Export/-Import gepflegt (Restliste R-10).
