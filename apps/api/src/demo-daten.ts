import { randomUUID } from 'node:crypto';
import { ageGroup, FOLLOWUP_PLAN_V1, OPS_EXAMPLES, OPS_EXAMPLE_VERSION, planEvents } from '@dart/domain';
import { AnswerMap, evaluateForm, FormItem, FormSchema } from '@dart/forms';
import { Client } from 'pg';

/**
 * SYNTHETISCHE Demodaten für Autoreport und Benchmarking (keine Echtdaten, keine realen Zusammenhänge).
 * Reproduzierbar (fester Zufallsstartwert), idempotent (Pseudonyme „P-DEMO…“), ohne E-Mail-Kontakt (kein Versand).
 * Verteilungen und Effekte sind frei erfunden und dienen nur der Darstellung.
 *
 *   SEED_DATABASE_URL=… VAULT_URL=… VAULT_TOKEN_API=… node apps/api/dist/demo-daten.js
 */
let state = 20261103;
const rnd = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const normal = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const iso = (d: Date) => d.toISOString().slice(0, 10);

const MODULE_PROFILE: Record<string, { p: number; base: number; gain: number; age: [number, number] }> = {
  MENISKUS: { p: 0.32, base: 0.5, gain: 0.25, age: [25, 60] },
  KNORPEL: { p: 0.2, base: 0.42, gain: 0.22, age: [20, 50] },
  KREUZBAND: { p: 0.2, base: 0.45, gain: 0.33, age: [16, 40] },
  OSTEOTOMIE: { p: 0.08, base: 0.4, gain: 0.25, age: [35, 60] },
  PATELLA: { p: 0.08, base: 0.48, gain: 0.26, age: [15, 35] },
  SYNOVITIS: { p: 0.05, base: 0.5, gain: 0.15, age: [30, 70] },
  ENDOPROTHETIK: { p: 0.07, base: 0.3, gain: 0.38, age: [55, 85] },
};
const SURGEON_EFFECT: Record<string, number> = { 'dr.nord': 0.05, 'dr.nord2': 0, 'dr.sued': -0.04 };
const TP_GAIN: Record<string, number> = { BL: 0, M6: 0.7, M12: 1, M24: 1.05, M36: 1.05, M60: 1 };
const TP_RESPONSE: Record<string, number> = { BL: 0.95, M6: 0.82, M12: 0.75, M24: 0.66, M36: 0.6, M60: 0.55 };

function itemsOf(s: FormSchema): FormItem[] {
  return s.sections.flatMap((x) => x.items);
}

/** Antworten aus latenter Gesundheit h (0 = schlecht, 1 = gut) erzeugen, je Item mit Rauschen. */
function answersFor(schema: FormSchema, h: number): AnswerMap {
  const out: AnswerMap = {};
  const items = itemsOf(schema);
  const computed = items.filter((i) => i.type === 'computed');
  for (const it of items) {
    if (it.type !== 'single' || !it.codes?.length) continue;
    if (rnd() < 0.015) continue; // vereinzelt fehlende Angaben
    const codes = it.codes.map((c) => Number(c.code));
    const lo = Math.min(...codes);
    const hi = Math.max(...codes);
    const comp = computed.find((c) => c.compute!.inputs.includes(it.id));
    const t = comp?.compute?.transforms?.[it.id];
    const frac = clamp(h + normal() * 0.12, 0, 1);
    let v: number;
    if (schema.code === 'KNIE-KOOS') v = t?.reverse ? lo + frac * (hi - lo) : hi - frac * (hi - lo); // KOOS: 0 = keine Beschwerden
    else v = t?.reverse ? hi - frac * (hi - lo) : lo + frac * (hi - lo);
    out[it.id] = { value: String(Math.round(clamp(v, lo, hi))) };
  }
  return out;
}

async function main() {
  const url = process.env.SEED_DATABASE_URL;
  if (!url) throw new Error('SEED_DATABASE_URL fehlt');
  if (process.env.NODE_ENV === 'production') throw new Error('Demodaten in Produktion verweigert');
  const target = Number(process.env.DEMO_FAELLE ?? 300);
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const existing = (await c.query(`SELECT count(*)::int AS n FROM patient WHERE pseudonym LIKE 'P-DEMO%'`)).rows[0].n;
    if (existing >= target) {
      console.log(`[demo] ${existing} synthetische Demofälle vorhanden – nichts zu tun`);
      return;
    }
    const centers = Object.fromEntries((await c.query('SELECT code, id FROM center')).rows.map((r) => [r.code, r.id]));
    const users = Object.fromEntries((await c.query('SELECT username, id FROM app_user')).rows.map((r) => [r.username, r.id]));
    const forms: Record<string, { id: string; schema: FormSchema }> = {};
    for (const r of (await c.query(`SELECT q.code, v.id, v.schema FROM questionnaire_version v JOIN questionnaire q ON q.id = v.questionnaire_id WHERE v.status = 'veroeffentlicht'`)).rows) forms[r.code] = { id: r.id, schema: r.schema };
    for (const need of ['KNIE-IKDC', 'KNIE-KOOS', 'KNIE-BASIC-ARZT', 'KNIE-PAT']) if (!forms[need]) throw new Error(`Formular ${need} nicht veröffentlicht (Seed ausführen)`);
    const doc = (await c.query(`SELECT id FROM consent_document_version WHERE code = 'DART-EW' LIMIT 1`)).rows[0].id;
    const today = new Date(Date.now() - 24 * 3600 * 1000);
    const start = new Date('2023-01-15T00:00:00Z');
    const vault = process.env.VAULT_URL;
    const token = process.env.VAULT_TOKEN_API;

    for (let i = existing; i < target; i++) {
      const centerCode = rnd() < 0.7 ? 'Z-101' : 'Z-102';
      const surgeonName = centerCode === 'Z-101' ? (rnd() < 0.5 ? 'dr.nord' : 'dr.nord2') : 'dr.sued';
      let mod = 'MENISKUS';
      let acc = 0;
      const u = rnd();
      for (const [m, prof] of Object.entries(MODULE_PROFILE)) {
        acc += prof.p;
        if (u <= acc) {
          mod = m;
          break;
        }
      }
      const modules = mod === 'KNORPEL' && rnd() < 0.25 ? ['KNORPEL', 'OSTEOTOMIE'] : [mod];
      const prof = MODULE_PROFILE[mod];
      const age = Math.round(prof.age[0] + rnd() * (prof.age[1] - prof.age[0]));
      const opDate = new Date(start.getTime() + rnd() * (today.getTime() - start.getTime() - 30 * 86400000));
      const op = iso(opDate);
      const birth = iso(new Date(Date.UTC(opDate.getUTCFullYear() - age, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))));
      const sex = rnd() < 0.46 ? 'weiblich' : rnd() < 0.98 ? 'maennlich' : 'divers';
      const science = centerCode === 'Z-101' && rnd() < 0.5;
      const registers = ['DART', ...(modules.includes('KNORPEL') ? ['KNORPEL_DGOU'] : []), ...(modules.includes('OSTEOTOMIE') ? ['DEKOR'] : [])];
      const centerId = centers[centerCode];
      const pseudonym = `P-DEMO${String(i + 1).padStart(4, '0')}`;

      let vaultRef: string = randomUUID();
      if (vault && token) {
        const r = await fetch(`${vault}/internal/v1/identities`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-dart-center-ids': centerId, 'x-dart-actor': 'demo-daten' },
          body: JSON.stringify({ centerId, firstName: 'Demo', lastName: `Synthetisch${i + 1}`, birthDate: birth, synthetic: true }),
        });
        if (r.ok) vaultRef = ((await r.json()) as { vaultRef: string }).vaultRef;
      }
      await c.query('BEGIN');
      const p = await c.query(`INSERT INTO patient (center_id, pseudonym, vault_ref, sex) VALUES ($1,$2,$3,$4) ON CONFLICT (pseudonym) DO NOTHING RETURNING id`, [centerId, pseudonym, vaultRef, sex]);
      if (!p.rows.length) {
        await c.query('ROLLBACK');
        continue;
      }
      const patientId = p.rows[0].id;
      const cs = await c.query(
        `INSERT INTO treatment_case (center_id, patient_id, joint, side, treatment_type, surgeon_user_id, planned_op_date, actual_op_date, status, age_group)
         VALUES ($1,$2,'knie',$3,'operativ',$4,$5,$5,'aktiv',$6) RETURNING id`,
        [centerId, patientId, rnd() < 0.5 ? 'links' : 'rechts', users[surgeonName], op, ageGroup(birth, op)],
      );
      const caseId = cs.rows[0].id;
      for (const reg of registers) await c.query('INSERT INTO case_register_membership (case_id, center_id, register_code) VALUES ($1,$2,$3)', [caseId, centerId, reg]);
      await c.query(`INSERT INTO capture_mode_history (case_id, center_id, mode, reason) VALUES ($1,$2,$3,'Synthetische Demodaten')`, [caseId, centerId, science ? 'science' : 'basic']);
      for (const m of modules) {
        await c.query('INSERT INTO case_module (case_id, center_id, module_code) VALUES ($1,$2,$3)', [caseId, centerId, m]);
        const ops = OPS_EXAMPLES.filter((o) => o.module === m);
        if (ops.length) {
          const o = pick(ops);
          await c.query(`INSERT INTO procedure (case_id, center_id, concept_code, ops_code, ops_version, source) VALUES ($1,$2,$3,$4,$5,'demo')`, [caseId, centerId, o.concept, o.code, OPS_EXAMPLE_VERSION]);
        }
      }
      const scopes = ['register_basic', ...(science ? ['science'] : []), ...(registers.includes('KNORPEL_DGOU') ? ['knorpelregister'] : []), ...(registers.includes('DEKOR') ? ['dekor'] : [])];
      const signed = iso(new Date(opDate.getTime() - 7 * 86400000));
      await c.query(
        `INSERT INTO consent_record (center_id, patient_id, document_version_id, status, method, scopes, signed_date, uploaded_at, reviewed_at, evidence_ref, evidence_sha256, evidence_package)
         VALUES ($1,$2,$3,'gueltig','papier_upload',$4,$5,$6,$6,$7,'synthetisch-ohne-dokument',$8)`,
        [centerId, patientId, doc, scopes, signed, new Date(opDate.getTime() - 6 * 86400000), randomUUID(), JSON.stringify({ hinweis: 'Synthetische Demodaten – kein Nachweisdokument' })],
      );

      const h0 = clamp(prof.base + normal() * 0.1 - Math.max(0, age - 45) * 0.002, 0.05, 0.95);
      const effect = SURGEON_EFFECT[surgeonName] ?? 0;
      const indiv = normal() * 0.06;
      for (const ev of planEvents(op, FOLLOWUP_PLAN_V1)) {
        const due = new Date(`${ev.dueDate}T00:00:00Z`);
        const respond = rnd() < TP_RESPONSE[ev.timepoint];
        const complete = due < today && respond;
        const status = complete ? 'abgeschlossen' : new Date(`${ev.windowEnd}T00:00:00Z`) < today ? 'eingeladen' : 'geplant';
        const e = await c.query(
          `INSERT INTO assessment_event (case_id, center_id, timepoint, plan_code, plan_version, reference_kind, due_date, window_start, window_end, status, started_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,'op_tatsaechlich',$6,$7,$8,$9,$10,$10) RETURNING id`,
          [caseId, centerId, ev.timepoint, FOLLOWUP_PLAN_V1.code, FOLLOWUP_PLAN_V1.version, ev.dueDate, ev.windowStart, ev.windowEnd, status, complete ? due : null],
        );
        if (!complete) continue;
        const h = clamp(h0 + (prof.gain + effect + indiv) * (TP_GAIN[ev.timepoint] ?? 1), 0.02, 0.99);
        const codes = ['KNIE-IKDC', 'KNIE-KOOS', ...(ev.timepoint === 'BL' ? ['KNIE-PAT', 'KNIE-BASIC-ARZT'] : [])];
        for (const code of codes) {
          const f = forms[code];
          let answers: AnswerMap;
          if (code === 'KNIE-BASIC-ARZT') {
            const vor = rnd() < 0.3;
            answers = { bas_vorop: { value: vor ? 'ja' : 'nein' }, ...(vor ? { bas_vorop_anzahl: { value: 1 + Math.floor(rnd() * 3) } } : {}), bas_asa: { value: String(1 + Math.floor(rnd() * 3)) }, bas_bmi: { value: Math.round((24 + normal() * 3.5 + (mod === 'ENDOPROTHETIK' ? 3 : 0)) * 10) / 10 } };
          } else if (code === 'KNIE-PAT') {
            const sport = rnd() < clamp(0.85 - age * 0.01, 0.1, 0.9);
            answers = { pq1: { value: String(Math.round(h * 4)) }, pq2: { value: String(Math.round(h * 4)) }, pq3: { value: String(Math.round(h * 4)) }, pq4: { value: String(Math.round(h * 4)) }, psport: { value: sport ? 'ja' : 'nein' } };
          } else answers = answersFor(f.schema, h);
          const evaluation = evaluateForm(f.schema, { answers, instances: {} });
          const r = await c.query(
            `INSERT INTO response (center_id, case_id, assessment_event_id, questionnaire_version_id, module_code, audience, status, revision, started_at, submitted_at)
             VALUES ($1,$2,$3,$4,'BASIS',$5,'abgeschlossen',2,$6,$6) RETURNING id`,
            [centerId, caseId, e.rows[0].id, f.id, code.endsWith('-ARZT') ? 'arzt' : 'patient', due],
          );
          const rid = r.rows[0].id;
          const keys = Object.keys(answers);
          if (keys.length) {
            const vals: unknown[] = [];
            const rows = keys.map((k, j) => {
              const a = answers[k];
              const num = typeof a.value === 'number';
              vals.push(rid, centerId, k, k, num ? null : a.value, num ? a.value : null);
              const b = j * 6;
              return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},'',$${b + 5},$${b + 6},NULL,NULL,NULL,true,2)`;
            });
            await c.query(`INSERT INTO answer (response_id, center_id, answer_key, item_id, repeat_instance_id, value_text, value_number, value_date, value_codes, missing_reason, active, updated_revision) VALUES ${rows.join(',')}`, vals);
          }
          await c.query(`INSERT INTO response_revision (response_id, center_id, revision, answers, instances, action, reason) VALUES ($1,$2,2,$3,'{}','abschluss','Synthetische Demodaten')`, [rid, centerId, JSON.stringify(answers)]);
          for (const s of evaluation.scores) {
            await c.query(
              `INSERT INTO derived_score (response_id, center_id, answer_key, algorithm, kind, value, reason, used_inputs, total_inputs, response_revision) VALUES ($1,$2,$3,$4,'neuberechnung',$5,$6,$7,$8,2)`,
              [rid, centerId, s.key, s.algorithm, s.value, s.reason ?? null, s.usedInputs, s.totalInputs],
            );
          }
        }
      }
      await c.query('COMMIT');
      if ((i + 1) % 50 === 0) console.log(`[demo] ${i + 1}/${target} synthetische Fälle`);
    }
    console.log(`[demo] fertig: ${target} synthetische Demofälle (P-DEMO…), ohne Kontaktdaten und ohne Versand`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
