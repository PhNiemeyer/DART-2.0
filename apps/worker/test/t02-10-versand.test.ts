import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseBody, centerIds, Client, digitalConsent } from '../../api/test/client';
import { buildExport } from '../src/exports';
import { MailProvider, OutgoingMail, SendError } from '../src/mail';
import { runOnce, WorkerDeps } from '../src/outbox';

/**
 * T02-10: Reminder-/Versand-Retry erzeugt kein zweites logisches Ereignis.
 * Fake-Anbieter: Die erste Übergabe wird angenommen, meldet aber eine Zeitüberschreitung (unklar).
 */
let pool: Pool;
let owner: Pool;

function fakeProvider(mode: { timeoutOnFirst?: boolean; refuse?: boolean; rejectRecipient?: boolean }) {
  const delivered: OutgoingMail[] = [];
  let calls = 0;
  const p: MailProvider & { delivered: OutgoingMail[]; calls: () => number } = {
    name: 'fake',
    delivered,
    calls: () => calls,
    async send(m) {
      calls++;
      if (mode.refuse) throw new SendError('abgelehnt', 'ECONNREFUSED');
      if (mode.rejectRecipient) throw new SendError('empfaenger', '550');
      delivered.push(m);
      if (mode.timeoutOnFirst && calls === 1) throw new SendError('unklar', 'ETIMEDOUT');
      return { providerId: `fake-${delivered.length}` };
    },
    async find(id) {
      const hit = delivered.find((d) => d.messageId === id);
      return hit ? `fake-found-${id}` : null;
    },
  };
  return p;
}

function deps(mail: MailProvider): WorkerDeps {
  return { pool, mail, contact: async () => 'synthetisch@example.invalid', webUrl: 'http://localhost:3000', messageDomain: 'test.invalid', staffDomain: 'staff.invalid' };
}

async function isolateOutbox(caseId: string) {
  // Nur Nachrichten dieses Testfalls fällig machen; alle anderen zurückstellen
  await owner.query(`UPDATE outbox_message SET next_attempt_at = now() + interval '1 day' WHERE case_id <> $1 AND status IN ('ausstehend','fehlgeschlagen','unklar')`, [caseId]);
  await owner.query(`UPDATE outbox_message SET next_attempt_at = now() + interval '1 day' WHERE case_id = $1 AND status = 'ausstehend'`, [caseId]);
  await owner.query(
    `UPDATE outbox_message o SET scheduled_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute'
      FROM assessment_event e WHERE e.id = o.assessment_event_id AND e.timepoint = 'BL' AND o.case_id = $1 AND o.kind = 'einladung' AND o.status = 'ausstehend'`,
    [caseId],
  );
}

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
  owner = new Pool({ connectionString: process.env.SEED_DATABASE_URL });
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

async function newCase(today: string) {
  const nord = await Client.login('dr.nord');
  const C = await centerIds(nord);
  const cs = (await nord.post('/api/v1/cases', caseBody(C['Z-101'], { plannedOpDate: today }))).body;
  await digitalConsent(nord, cs.patientId, ['register_basic', 'kontakt_followup']);
  return { nord, cs };
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

describe('T02-10 Versand-Retry', () => {
  it('unklares Ergebnis wird abgeglichen statt erneut gesendet; Erinnerungen nur einmal geplant', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    const mail = fakeProvider({ timeoutOnFirst: true });
    const r1 = await runOnce(deps(mail));
    expect(r1.unklar).toBe(1);
    // Backoff überspringen
    await owner.query(`UPDATE outbox_message SET next_attempt_at = now() WHERE case_id = $1 AND status = 'unklar'`, [cs.id]);
    const r2 = await runOnce(deps(mail));
    expect(r2.abgeglichen).toBe(1);
    expect(mail.calls()).toBe(1);
    expect(mail.delivered).toHaveLength(1);
    expect(mail.delivered[0].text).toMatch(/portal\/einladung#t=/);
    expect(mail.delivered[0].text).not.toMatch(/Knie|Diagnose|Knorpel/);
    const om = (await owner.query(`SELECT kind, stage, status, attempts FROM outbox_message WHERE case_id = $1 ORDER BY stage`, [cs.id])).rows;
    const inv = (await owner.query(`SELECT status, attempts FROM outbox_message WHERE case_id = $1 AND stage = 'einladung' AND assessment_event_id = (SELECT id FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL')`, [cs.id])).rows[0];
    expect(inv).toMatchObject({ status: 'versendet', attempts: 2 });
    expect(om.filter((x) => x.kind === 'erinnerung').map((x) => x.stage)).toEqual(['erinnerung-1', 'erinnerung-2']);
    const att = (await owner.query(`SELECT result FROM delivery_attempt d JOIN outbox_message o ON o.id = d.outbox_id WHERE o.case_id = $1 AND o.stage = 'einladung' AND o.assessment_event_id = (SELECT id FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL') ORDER BY attempt_no`, [cs.id])).rows.map((x) => x.result);
    expect(att).toEqual(['unklar', 'abgeglichen']);
    // Weitere Läufe erzeugen keine zweite Einladung und keine doppelten Erinnerungen
    await runOnce(deps(mail));
    const count = (await owner.query(`SELECT count(*)::int AS n FROM outbox_message WHERE case_id = $1`, [cs.id])).rows[0].n;
    expect(count).toBe(om.length);
    expect(mail.delivered).toHaveLength(1);
    const ev = (await owner.query(`SELECT status FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL'`, [cs.id])).rows[0];
    expect(['geplant', 'eingeladen']).toContain(ev.status);
  });

  it('sicher abgelehnte Zustellung: Backoff, nach 5 Versuchen Dead Letter', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    const mail = fakeProvider({ refuse: true });
    for (let i = 0; i < 5; i++) {
      await owner.query(`UPDATE outbox_message SET next_attempt_at = now() WHERE case_id = $1 AND stage = 'einladung' AND assessment_event_id = (SELECT id FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL')`, [cs.id]);
      await runOnce(deps(mail));
    }
    const m = (await owner.query(`SELECT status, attempts FROM outbox_message WHERE case_id = $1 AND stage = 'einladung' AND assessment_event_id = (SELECT id FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL')`, [cs.id])).rows[0];
    expect(m).toEqual({ status: 'dead_letter', attempts: 5 });
  });

  it('Widerruf zwischen Planung und Versand: Consent-Prüfung direkt vor Versand storniert', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    // Widerruf direkt in der DB simulieren, ohne dass die API die Outbox storniert (Schutz greift im Worker)
    await owner.query(`UPDATE consent_record SET status = 'widerrufen' WHERE patient_id = $1`, [cs.patientId]);
    const mail = fakeProvider({});
    const r = await runOnce(deps(mail));
    expect(r.storniert).toBeGreaterThanOrEqual(1);
    expect(mail.delivered).toHaveLength(0);
  });
});

describe('Versand-Leitstand (R-14) im Worker', () => {
  const blInvite = `case_id = $1 AND stage = 'einladung' AND assessment_event_id = (SELECT id FROM assessment_event WHERE case_id = $1 AND timepoint = 'BL')`;

  it('Abmeldung (nur E-Mail-Kanal): Worker storniert statt zu senden; Einwilligung bleibt gültig', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    await owner.query(`INSERT INTO contact_preference (patient_id, center_id, email_status, source) SELECT id, center_id, 'abgemeldet', 'portal' FROM patient WHERE id = $1`, [cs.patientId]);
    const mail = fakeProvider({});
    await runOnce(deps(mail));
    expect(mail.delivered).toHaveLength(0);
    expect((await owner.query(`SELECT status, cancel_reason FROM outbox_message WHERE ${blInvite}`, [cs.id])).rows[0]).toEqual({ status: 'storniert', cancel_reason: 'E-Mail-Erinnerungen abbestellt' });
    expect((await owner.query('SELECT status FROM consent_record WHERE patient_id = $1', [cs.patientId])).rows[0].status).toBe('gueltig');
  });

  it('eingeschränkte Verarbeitung (R-19): Worker storniert statt zu senden', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    await owner.query(`UPDATE patient SET restricted_at = now(), restricted_reason = 'Test' WHERE id = $1`, [cs.patientId]);
    const mail = fakeProvider({});
    await runOnce(deps(mail));
    expect(mail.delivered).toHaveLength(0);
    expect((await owner.query(`SELECT status, cancel_reason FROM outbox_message WHERE ${blInvite}`, [cs.id])).rows[0]).toEqual({ status: 'storniert', cancel_reason: 'Verarbeitung eingeschränkt' });
  });

  it('dauerhaft abgewiesene Empfängeradresse: sofort Dead Letter, Kontakt „unzustellbar“, kein weiterer Versuch', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    const mail = fakeProvider({ rejectRecipient: true });
    const r = await runOnce(deps(mail));
    expect(r.unzustellbar).toBe(1);
    expect((await owner.query(`SELECT status, attempts FROM outbox_message WHERE ${blInvite}`, [cs.id])).rows[0]).toEqual({ status: 'dead_letter', attempts: 1 });
    expect((await owner.query('SELECT email_status, source FROM contact_preference WHERE patient_id = $1', [cs.patientId])).rows[0]).toEqual({ email_status: 'unzustellbar', source: 'versand' });
    expect((await owner.query(`SELECT result FROM delivery_attempt WHERE outbox_id = (SELECT id FROM outbox_message WHERE ${blInvite})`, [cs.id])).rows.map((x) => x.result)).toEqual(['unzustellbar']);
  });

  it('erneut eingereiht: Versuchsbudget gilt je Nachricht, Versuchsnummern laufen weiter', async () => {
    const { cs } = await newCase(today());
    await isolateOutbox(cs.id);
    await owner.query(`UPDATE outbox_message SET status = 'ausstehend', attempts = 5, max_attempts = 10, next_attempt_at = now() WHERE ${blInvite}`, [cs.id]);
    const mail = fakeProvider({});
    expect((await runOnce(deps(mail))).versendet).toBe(1);
    expect((await owner.query(`SELECT status, attempts FROM outbox_message WHERE ${blInvite}`, [cs.id])).rows[0]).toEqual({ status: 'versendet', attempts: 6 });
  });
});

describe('Export (F19)', () => {
  it('Formelinjektion entschärft, Science schließt Basic-Fälle aus, Manifest mit Prüfsummen', async () => {
    const nord = await Client.login('dr.nord');
    const C = await centerIds(nord);
    const cs = (await nord.post('/api/v1/cases', caseBody(C['Z-101'], { plannedOpDate: '2026-06-15' }))).body;
    await digitalConsent(nord, cs.patientId);
    const resp = (await nord.get(`/api/v1/cases/${cs.id}`)).body.responses.find((r: { audience: string }) => r.audience === 'arzt');
    const s = await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { bas_vorop: { value: 'nein' }, bas_asa: { value: '1' }, bas_befund: { value: '=HYPERLINK("http://boese.invalid")' } } }, { 'if-match': '1' });
    expect((await nord.post(`/api/v1/responses/${resp.id}/submit`, {}, { 'if-match': String(s.body.revision) })).status).toBe(201);
    const insertJob = async (scope: string, layers: string) =>
      (await owner.query(
        `INSERT INTO export_job (requested_by, purpose, scope, center_ids, period_from, period_to, layers, status)
         SELECT id, 'Synthetischer Exporttest', $2, $1, '2026-06-15', '2026-06-15', $3, 'abgelehnt' FROM app_user WHERE username = 'forschung' RETURNING *`,
        [[C['Z-101']], scope, layers],
      )).rows[0];
    const j = await insertJob('basic', '{normalisiert,scores}');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const sum = await buildExport(c, j);
      expect(sum.faelle).toBeGreaterThanOrEqual(1);
      const files = (await c.query(`SELECT file_name, convert_from(content, 'UTF8') AS text, sha256 FROM export_file WHERE export_job_id = $1`, [j.id])).rows;
      await c.query('ROLLBACK');
      const answers = files.find((f) => f.file_name === 'antworten.csv')!.text as string;
      expect(answers).toContain(`"'=HYPERLINK(""http://boese.invalid"")"`);
      expect(answers).not.toMatch(/;=HYPERLINK/);
      const manifest = JSON.parse(files.find((f) => f.file_name === 'manifest.json')!.text);
      expect(manifest.dateien.find((d: { name: string }) => d.name === 'antworten.csv').sha256).toBe(files.find((f) => f.file_name === 'antworten.csv')!.sha256);
      expect(manifest.kleingruppen.schwelle).toBe(5);
      const sci = await insertJob('science', '{normalisiert}');
      await c.query('BEGIN');
      const ss = await buildExport(c, sci);
      await c.query('ROLLBACK');
      expect(ss.ausgeschlossen['Modus nicht Science']).toBeGreaterThanOrEqual(1);
    } finally {
      c.release();
    }
  });
});
