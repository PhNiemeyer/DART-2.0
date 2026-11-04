import { consentAllows, MODE_LABELS, SMALL_CELL_THRESHOLD, toCsv } from '@dart/domain';
import { FormSchema, indexItems, MISSING_CODES, SCORE_REGISTRY } from '@dart/forms';
import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

/**
 * Forschungsexport (F19): nur genehmigte Aufträge, zweckgebunden, pseudonym mit exportspezifischen
 * Kennungen, Datenwörterbuch, Missing-Codes, Versionen, Stichtag, Prüfsummen, Formelinjektionsschutz,
 * Kleingruppenprüfung. Basic-Daten werden NICHT automatisch für Science freigegeben.
 */
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

function exportId(prefix: string, jobId: string, internal: string) {
  return `${prefix}-${sha256(`${jobId}:${internal}`).slice(0, 10).toUpperCase()}`;
}

export async function processExports(pool: Pool): Promise<number> {
  const c = await pool.connect();
  let done = 0;
  try {
    for (;;) {
      await c.query('BEGIN');
      const job = (await c.query(`SELECT * FROM export_job WHERE status = 'genehmigt' ORDER BY decided_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!job) {
        await c.query('COMMIT');
        break;
      }
      await c.query(`UPDATE export_job SET status = 'in_arbeit' WHERE id = $1`, [job.id]);
      await c.query('COMMIT');
      try {
        await c.query('BEGIN');
        const summary = await buildExport(c, job);
        await c.query(`UPDATE export_job SET status = 'fertig', stichtag = now(), result_summary = $2 WHERE id = $1`, [job.id, JSON.stringify(summary)]);
        await c.query(`INSERT INTO audit_event (actor_kind, action, object_type, object_id, result) VALUES ('worker','export_erstellt','export',$1,'erfolg')`, [job.id]);
        await c.query('COMMIT');
        done++;
      } catch (e) {
        await c.query('ROLLBACK');
        await c.query(`UPDATE export_job SET status = 'fehler', result_summary = $2 WHERE id = $1`, [job.id, JSON.stringify({ fehler: (e as Error).message.slice(0, 200) })]);
      }
    }
  } finally {
    c.release();
  }
  return done;
}

interface Job {
  id: string;
  purpose: string;
  scope: 'basic' | 'science';
  center_ids: string[] | null;
  period_from: string;
  period_to: string;
  layers: string[];
}

export async function buildExport(c: PoolClient, job: Job) {
  const stichtag = new Date().toISOString();
  const cases = (await c.query(
    `SELECT tc.id, tc.patient_id, ce.code AS center_code, tc.joint, tc.side, tc.treatment_type,
            to_char(COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date), 'YYYY-MM') AS bezugsmonat,
            (SELECT mode FROM capture_mode_history h WHERE h.case_id = tc.id AND h.valid_to IS NULL) AS mode,
            COALESCE((SELECT array_agg(register_code ORDER BY register_code) FROM case_register_membership r WHERE r.case_id = tc.id AND r.valid_to IS NULL), '{}') AS registers,
            COALESCE((SELECT array_agg(module_code ORDER BY module_code) FROM case_module m WHERE m.case_id = tc.id AND m.active), '{}') AS modules
       FROM treatment_case tc JOIN center ce ON ce.id = tc.center_id JOIN patient pa ON pa.id = tc.patient_id
      WHERE ($1::uuid[] IS NULL OR tc.center_id = ANY($1))
        AND pa.restricted_at IS NULL -- eingeschränkte Verarbeitung (R-19): nicht exportieren
        AND COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) BETWEEN $2 AND $3`,
    [job.center_ids, job.period_from, job.period_to],
  )).rows;
  const eligible: typeof cases = [];
  const excluded: Record<string, number> = {};
  for (const cs of cases) {
    const consents = (await c.query('SELECT status, scopes FROM consent_record WHERE patient_id = $1', [cs.patient_id])).rows;
    const needed = job.scope === 'science' ? ['register_basic', 'science'] : ['register_basic'];
    if (job.scope === 'science' && cs.mode !== 'science') {
      excluded['Modus nicht Science'] = (excluded['Modus nicht Science'] ?? 0) + 1;
      continue;
    }
    const g = consentAllows(consents, needed as never);
    if (!g.ok) {
      excluded['Einwilligung fehlt/widerrufen/Umfang unzureichend'] = (excluded['Einwilligung fehlt/widerrufen/Umfang unzureichend'] ?? 0) + 1;
      continue;
    }
    eligible.push(cs);
  }
  const caseIdMap = new Map(eligible.map((cs) => [cs.id, exportId('F', job.id, cs.id)]));
  const files: Array<{ name: string; type: string; content: string }> = [];
  const caseRows = eligible.map((cs) => ({
    fall_id: caseIdMap.get(cs.id),
    patient_id: exportId('P', job.id, cs.patient_id),
    zentrum: cs.center_code,
    gelenk: cs.joint,
    seite: cs.side,
    behandlung: cs.treatment_type,
    modus: cs.mode,
    register: cs.registers.join('|'),
    module: cs.modules.join('|'),
    bezugsmonat: cs.bezugsmonat,
  }));
  const caseCols = ['fall_id', 'patient_id', 'zentrum', 'gelenk', 'seite', 'behandlung', 'modus', 'register', 'module', 'bezugsmonat'];
  files.push({ name: 'faelle.csv', type: 'text/csv; charset=utf-8', content: toCsv(caseCols, caseRows) });
  files.push({ name: 'faelle.json', type: 'application/json', content: JSON.stringify(caseRows, null, 2) });

  const ids = eligible.map((cs) => cs.id);
  const responses = ids.length
    ? (await c.query(
        `SELECT r.id, r.case_id, e.timepoint, q.code, qv.version, qv.schema_hash, qv.schema
           FROM response r JOIN assessment_event e ON e.id = r.assessment_event_id JOIN questionnaire_version qv ON qv.id = r.questionnaire_version_id
           JOIN questionnaire q ON q.id = qv.questionnaire_id WHERE r.case_id = ANY($1) AND r.status = 'abgeschlossen'`,
        [ids],
      )).rows
    : [];
  const formVersions = new Map<string, { code: string; version: number; hash: string; schema: FormSchema }>();
  for (const r of responses) formVersions.set(`${r.code}@${r.version}`, { code: r.code, version: r.version, hash: r.schema_hash, schema: r.schema });

  if (job.layers.includes('normalisiert')) {
    const answerRows: Array<Record<string, unknown>> = [];
    for (const r of responses) {
      const idx = indexItems(r.schema);
      const ans = (await c.query('SELECT * FROM answer WHERE response_id = $1 AND active ORDER BY answer_key', [r.id])).rows;
      for (const a of ans) {
        const item = idx.get(a.item_id)?.item;
        answerRows.push({
          fall_id: caseIdMap.get(r.case_id),
          zeitpunkt: r.timepoint,
          formular: r.code,
          formularversion: r.version,
          var_id: item?.varId ?? a.item_id,
          instanz: a.repeat_instance_id || '',
          wert: a.value_codes ?? a.value_number ?? a.value_date ?? a.value_text ?? '',
          fehlgrund: a.missing_reason ?? '',
        });
      }
    }
    files.push({ name: 'antworten.csv', type: 'text/csv; charset=utf-8', content: toCsv(['fall_id', 'zeitpunkt', 'formular', 'formularversion', 'var_id', 'instanz', 'wert', 'fehlgrund'], answerRows) });
  }
  if (job.layers.includes('scores')) {
    const scoreRows: Array<Record<string, unknown>> = [];
    for (const r of responses) {
      const s = (await c.query(
        `SELECT DISTINCT ON (answer_key, algorithm, kind) answer_key, algorithm, kind, value, reason FROM derived_score WHERE response_id = $1 ORDER BY answer_key, algorithm, kind, response_revision DESC`,
        [r.id],
      )).rows;
      for (const x of s) scoreRows.push({ fall_id: caseIdMap.get(r.case_id), zeitpunkt: r.timepoint, formular: r.code, formularversion: r.version, algorithmus: x.algorithm, art: x.kind, wert: x.value ?? '', grund: x.reason ?? '' });
    }
    files.push({ name: 'scores.csv', type: 'text/csv; charset=utf-8', content: toCsv(['fall_id', 'zeitpunkt', 'formular', 'formularversion', 'algorithmus', 'art', 'wert', 'grund'], scoreRows) });
  }
  const dict: Array<Record<string, unknown>> = [];
  for (const f of formVersions.values()) {
    for (const [, e] of indexItems(f.schema)) {
      if (e.item.type === 'group') continue;
      dict.push({ formular: f.code, formularversion: f.version, formular_sha256: f.hash, var_id: e.item.varId, item_id: e.item.id, bezeichnung: e.item.label, typ: e.item.type, einheit: e.item.unit ?? '', methode: e.item.method ?? '', codes: (e.item.codes ?? []).map((x) => `${x.code}=${x.label}`).join(' | '), gruppe: e.group?.id ?? '' });
    }
  }
  files.push({ name: 'datenwoerterbuch.csv', type: 'text/csv; charset=utf-8', content: toCsv(['formular', 'formularversion', 'formular_sha256', 'var_id', 'item_id', 'bezeichnung', 'typ', 'einheit', 'methode', 'codes', 'gruppe'], dict) });

  // Kleingruppenprüfung je Zentrum
  const perCenter: Record<string, number> = {};
  for (const r of caseRows) perCenter[r.zentrum] = (perCenter[r.zentrum] ?? 0) + 1;
  const smallGroups = Object.entries(perCenter).filter(([, n]) => n > 0 && n < SMALL_CELL_THRESHOLD).map(([z]) => z);
  const manifest = {
    format: 'DART-Forschungsexport',
    formatVersion: 1,
    exportId: job.id,
    zweck: job.purpose,
    umfang: `${job.scope} (${MODE_LABELS[job.scope]})`,
    zeitraum: { von: job.period_from, bis: job.period_to },
    stichtag,
    ebenen: job.layers,
    kennungen: 'Exportspezifische Pseudonyme (nicht mit Registerpseudonymen verknüpfbar ohne Exportschlüssel)',
    formularversionen: [...formVersions.values()].map((f) => ({ code: f.code, version: f.version, sha256: f.hash })),
    scorealgorithmen: Object.entries(SCORE_REGISTRY).map(([ref, s]) => ({ ref, name: s.name, rundung: s.rounding, maxMissingShare: s.maxMissingShare })),
    mappingversion: 'nicht zutreffend (keine Migrationsdaten in diesem Export)',
    missingCodes: MISSING_CODES,
    faelle: caseRows.length,
    ausgeschlossen: excluded,
    kleingruppen: { schwelle: SMALL_CELL_THRESHOLD, zentrenUnterSchwelle: smallGroups, hinweis: smallGroups.length ? 'Reidentifikationsrisiko prüfen: Zentren mit weniger Fällen als Schwelle.' : 'Keine Kleingruppen unter Schwelle.' },
    csv: 'UTF-8, Semikolon, CRLF; Zellen mit = + - @ am Anfang sind mit Apostroph entschärft',
    hinweis: 'Prototyp – ausschließlich synthetische Daten. Basic-Daten sind nicht automatisch für Science-Publikationen freigegeben.',
    dateien: files.map((f) => ({ name: f.name, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content) })),
  };
  files.push({ name: 'manifest.json', type: 'application/json', content: JSON.stringify(manifest, null, 2) });
  for (const f of files) {
    await c.query('INSERT INTO export_file (export_job_id, file_name, content_type, content, sha256) VALUES ($1,$2,$3,$4,$5)', [job.id, f.name, f.type, Buffer.from(f.content, 'utf8'), sha256(f.content)]);
  }
  return { faelle: caseRows.length, ausgeschlossen: excluded, kleingruppen: smallGroups, dateien: files.length };
}
