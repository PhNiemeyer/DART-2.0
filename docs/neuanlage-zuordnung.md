# Neuanlage-Vorschläge (Q02, Blatt „Neuanlage“) → Umsetzung im Prototyp

Die 33 Vorschläge sind technische Felder/Feldgruppen, keine medizinischen Fragen. Alle stehen in der Quelle auf
„Vorschlag; Zielmodell freizugeben“. Diese Tabelle zeigt, wo der Prototyp sie abbildet – das ersetzt **nicht** die Freigabe des Zielmodells.

Legende: **abgebildet** = Struktur vorhanden und getestet · **teilweise** = Kern vorhanden, Abweichung genannt · **offen** = nicht umgesetzt.

| Nr. | Vorschlag | Ebene | Umsetzung im Prototyp | Status |
|---|---|---|---|---|
| 1 | patient_id | Patient | `patient.id` (UUID) + `pseudonym`; Identität getrennt im Vault (`vault_ref`) | abgebildet |
| 2 | case_id | Fall | `treatment_case.id`, `case_no`; Patient 1:n Fall (T02-2) | abgebildet |
| 3 | center_id | Zentrum | `center_id` auf allen Fachtabellen, RLS | abgebildet |
| 4 | case_register_membership | Fall | `case_register_membership` (DART, KnorpelRegister DGOU, DEKOR) mit Gültigkeit | abgebildet |
| 5 | case_joint_side | Fall | `treatment_case.joint`, `side` | abgebildet |
| 6 | capture_mode_history | Fall | `capture_mode_history` mit `valid_from`/`valid_to`, Begründung | abgebildet |
| 7 | case_modules | Fall | `case_module` (mehrere gleichzeitig) | abgebildet |
| 8 | planned_operation_date | Fall | `treatment_case.planned_op_date`; Arzt-Erinnerung +3 Tage (Outbox) | abgebildet |
| 9 | actual_operation_date | Fall | `treatment_case.actual_op_date`; Bezug Follow-up | abgebildet |
| 10 | treatment_reference_date | Fall | `conservative_start_date` + `assessment_event.reference_kind` | abgebildet |
| 11 | assessment_event_id | Erhebung | `assessment_event.id`; Wiederholungen über `answer.repeat_instance_id` | abgebildet |
| 12 | assessment_started_at / completed_at | Erhebung | `assessment_event.started_at`/`completed_at`, getrennt von `created_at` und OP-Datum | abgebildet |
| 13 | questionnaire_version_id | Erhebung | `response.questionnaire_version_id` (unveränderliche Version, T02-7) | abgebildet |
| 14 | variable_concept_id / definition_version_id | Definition | `variable_concept`, `variable_definition_version` (bei Veröffentlichung abgeleitet) | abgebildet |
| 15 | codelist_version_id | Definition | Codes sind Teil des versionierten, gehashten Formularschemas (ADR-0004), keine eigene Tabelle | teilweise |
| 16 | branch_rule_version_id | Definition | `visibleIf` im versionierten Schema; Modus-/Modulsteuerung über Zuordnungsmatrix V1 | teilweise |
| 17 | validation_rule_version_id | Definition | `validations`, Pflicht, Bereiche im versionierten Schema | teilweise |
| 18 | score_algorithm_version_id | Auswertung | `score_algorithm_version`, `derived_score.algorithm` (`DEMO-SCORE@1`) | abgebildet |
| 19 | score_provenance | Auswertung | `derived_score.kind` (Neuberechnung/Original), Revision, Eingänge gezählt | teilweise (Originalscores nicht übernommen, R-13) |
| 20 | missing_reason | Antwort | `answer.missing_reason`; „nicht angezeigt“ über `answer.active=false`; Importfehler über Migrationsstatus „ungeklärt“ | teilweise (Codeliste fachlich freizugeben) |
| 21 | legacy_source_key | Migration | `legacy_record` (System, Export, Blatt, Zeile, Datensatz-ID) + `legacy_value.source_key` | abgebildet |
| 22 | source_definition_version | Migration | `legacy.catalog_entry` (V05) + `migration_batch.mapping_version_id` | teilweise (Versionsnachweis je Altversion offen) |
| 23 | migration_batch_id / mapping_version | Migration | `legacy.migration_batch`, `legacy.mapping_rule_version` | abgebildet |
| 24 | migration_origin / imported_at | Migration | `assessment_event.source` (plan/migration), `legacy_record.created_at` | teilweise (keine Übernahme in Live-Fälle) |
| 25 | mapping_status / comparison_status | Migration | `legacy_value.outcome` und `comparability` (direkt/transformiert/nicht vergleichbar/ungeklärt) | abgebildet |
| 26 | consent_version / consent_scope | Einwilligung | `consent_document_version`, `consent_record.scopes` | abgebildet |
| 27 | consent_signed_at / evidence_ref | Einwilligung | `signed_date`, `uploaded_at`, `reviewed_at`, `evidence_ref`, `evidence_sha256` | abgebildet |
| 28 | consent_status / withdrawal_at | Einwilligung | Zustandsautomat + `withdrawal_event.withdrawn_at` | abgebildet |
| 29 | center_science_approval | Zentrum | `center_science_approval` mit Gültigkeit und Nachweis | abgebildet |
| 30 | invitation_event / reminder_event | Kommunikation | `invitation` (Token-Hash), `outbox_message`, `delivery_attempt`; 7/12 Tage | abgebildet |
| 31 | response_status / audit_event | Erhebung | `response.status`, `response_revision`, `audit_event` | abgebildet |
| 32 | user_center_role | Berechtigung | `user_center_role`; Anlage nur zentral (F01) | abgebildet |
| 33 | language / translation_version | Definition | nicht umgesetzt; Oberfläche und Bögen nur Deutsch | offen (R-24) |

Ergebnis: 25 abgebildet, 7 teilweise, 1 offen. Die Freigabe des Zielmodells steht aus (Entscheidung E-11).
