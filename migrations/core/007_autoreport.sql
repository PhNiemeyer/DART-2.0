-- Autoreporting und Benchmarking (Auftrag 03.11.2026).
-- Merkmale: Geschlecht (Entscheidung des Auftraggebers, abweichend von V05 CA_SEX „Entfall“), Altersgruppe bei Behandlung
-- (nur 5-Jahres-Gruppe im pseudonymen Kern; Geburtsdatum bleibt im Vault).
ALTER TABLE patient ADD COLUMN sex text CHECK (sex IN ('weiblich','maennlich','divers','unbekannt'));
ALTER TABLE treatment_case ADD COLUMN age_group text CHECK (age_group ~ '^(<18|[0-9]{2}–[0-9]{2}|85\+)$');

-- ---------------------------------------------------------------------------
-- Kernfunktionen (SECURITY INVOKER): laufen unter RLS des Aufrufers und liefern NUR Aggregate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION report_case_groups(p_case uuid, p_dim text) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE p_dim
    WHEN 'modul' THEN COALESCE((SELECT array_agg(module_code ORDER BY module_code) FROM case_module WHERE case_id = p_case AND active), ARRAY['NUR_BASIS'])
    WHEN 'eingriff' THEN COALESCE((SELECT array_agg(DISTINCT concept_code) FROM procedure WHERE case_id = p_case), ARRAY['OHNE_EINGRIFF'])
    WHEN 'modus' THEN ARRAY[(SELECT mode FROM capture_mode_history WHERE case_id = p_case AND valid_to IS NULL)]
    WHEN 'behandlung' THEN ARRAY[(SELECT treatment_type FROM treatment_case WHERE id = p_case)]
    ELSE ARRAY['GESAMT'] END
$$;

CREATE OR REPLACE FUNCTION report_scores_raw(p_alg text, p_tp text, p_dim text, p_from date, p_to date, p_delta boolean,
                                             p_center_ids uuid[] DEFAULT NULL, p_surgeon uuid DEFAULT NULL)
RETURNS TABLE (gruppe text, n integer, mean numeric, sd numeric)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT DISTINCT ON (r.id) tc.id AS case_id, e.timepoint, ds.value
      FROM derived_score ds
      JOIN response r ON r.id = ds.response_id AND r.status = 'abgeschlossen'
      JOIN assessment_event e ON e.id = r.assessment_event_id
      JOIN treatment_case tc ON tc.id = r.case_id
     WHERE ds.algorithm = p_alg AND ds.kind = 'neuberechnung' AND ds.value IS NOT NULL
       AND (p_center_ids IS NULL OR tc.center_id = ANY (p_center_ids))
       AND (p_surgeon IS NULL OR tc.surgeon_user_id = p_surgeon)
       AND (p_from IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= p_from)
       AND (p_to IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= p_to)
       AND e.timepoint IN (p_tp, 'BL')
     ORDER BY r.id, ds.response_revision DESC
  ), v AS (
    SELECT t.case_id, CASE WHEN p_delta THEN t.value - b.value ELSE t.value END AS wert
      FROM s t LEFT JOIN s b ON b.case_id = t.case_id AND b.timepoint = 'BL'
     WHERE t.timepoint = p_tp AND (NOT p_delta OR (b.value IS NOT NULL AND p_tp <> 'BL'))
  )
  SELECT g AS gruppe, count(*)::int, round(avg(v.wert), 2), round(stddev_samp(v.wert), 2)
    FROM v CROSS JOIN LATERAL unnest(report_case_groups(v.case_id, p_dim)) AS g
   GROUP BY g
$$;

CREATE OR REPLACE FUNCTION report_characteristics_raw(p_from date, p_to date, p_center_ids uuid[] DEFAULT NULL, p_surgeon uuid DEFAULT NULL)
RETURNS TABLE (merkmal text, auspraegung text, n integer, mean numeric)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT tc.*, p.sex FROM treatment_case tc JOIN patient p ON p.id = tc.patient_id
     WHERE (p_center_ids IS NULL OR tc.center_id = ANY (p_center_ids))
       AND (p_surgeon IS NULL OR tc.surgeon_user_id = p_surgeon)
       AND (p_from IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= p_from)
       AND (p_to IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= p_to)
  ), a AS (
    SELECT DISTINCT ON (r.case_id, an.item_id) r.case_id, an.item_id, an.value_text, an.value_number
      FROM answer an JOIN response r ON r.id = an.response_id JOIN assessment_event e ON e.id = r.assessment_event_id
     WHERE an.active AND e.timepoint = 'BL' AND an.item_id IN ('bas_bmi', 'bas_vorop', 'ba_vorop', 'psport')
       AND r.case_id IN (SELECT id FROM c)
     ORDER BY r.case_id, an.item_id, an.updated_at DESC
  )
  SELECT 'faelle', 'gesamt', count(*)::int, NULL::numeric FROM c
  UNION ALL SELECT 'altersgruppe', COALESCE(age_group, 'unbekannt'), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'geschlecht', COALESCE(sex, 'nicht erfasst'), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'seite', side, count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'behandlung', treatment_type, count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'modus', (SELECT mode FROM capture_mode_history h WHERE h.case_id = c.id AND h.valid_to IS NULL), count(*)::int, NULL FROM c GROUP BY 2
  UNION ALL SELECT 'bmi', 'Mittelwert', count(*)::int, round(avg(value_number), 2) FROM a WHERE item_id = 'bas_bmi' AND value_number IS NOT NULL
  UNION ALL SELECT 'voroperation', value_text, count(DISTINCT case_id)::int, NULL FROM a WHERE item_id IN ('bas_vorop', 'ba_vorop') AND value_text IS NOT NULL GROUP BY 2
  UNION ALL SELECT 'sport', value_text, count(*)::int, NULL FROM a WHERE item_id = 'psport' AND value_text IS NOT NULL GROUP BY 2
$$;

-- ---------------------------------------------------------------------------
-- Benchmark Gesamtkollektiv (SECURITY DEFINER): alle Zentren, ohne Filter auf einzelne Zentren
-- oder Operateure, Kleingruppen (< 5) unterdrückt. Liefert nie Einzelfälle oder Zentrumswerte.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION report_scores_gesamt(p_alg text, p_tp text, p_dim text, p_from date, p_to date, p_delta boolean)
RETURNS TABLE (gruppe text, n integer, mean numeric, sd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT gruppe, n, CASE WHEN n >= 5 THEN mean END, CASE WHEN n >= 5 THEN sd END
    FROM report_scores_raw(p_alg, p_tp, p_dim, p_from, p_to, p_delta, NULL, NULL)
$$;

CREATE OR REPLACE FUNCTION report_characteristics_gesamt(p_from date, p_to date)
RETURNS TABLE (merkmal text, auspraegung text, n integer, mean numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT merkmal, auspraegung, CASE WHEN n >= 5 THEN n END, CASE WHEN n >= 5 THEN mean END
    FROM report_characteristics_raw(p_from, p_to, NULL, NULL)
$$;

REVOKE ALL ON FUNCTION report_scores_gesamt(text, text, text, date, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION report_characteristics_gesamt(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_scores_raw(text, text, text, date, date, boolean, uuid[], uuid) TO dart_app;
GRANT EXECUTE ON FUNCTION report_characteristics_raw(date, date, uuid[], uuid) TO dart_app;
GRANT EXECUTE ON FUNCTION report_case_groups(uuid, text) TO dart_app;
GRANT EXECUTE ON FUNCTION report_scores_gesamt(text, text, text, date, date, boolean) TO dart_app;
GRANT EXECUTE ON FUNCTION report_characteristics_gesamt(date, date) TO dart_app;
GRANT SELECT ON patient TO dart_worker;
