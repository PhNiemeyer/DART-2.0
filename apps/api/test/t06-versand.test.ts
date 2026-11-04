import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseBody, centerIds, Client, digitalConsent, uniqueName } from './client';

/** Versand-Leitstand (R-14): Dead Letters, unklare Zustellungen, Abmeldungen. Nur synthetische Daten. */
let nord: Client;
let doku: Client;
let C: Record<string, string>;
const owner = new Pool({ connectionString: process.env.SEED_DATABASE_URL });

async function newCase() {
  const r = await nord.post('/api/v1/cases', caseBody(C['Z-101']));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; patientId: string };
}

/** Nachricht in einem bestimmten Zustand anlegen (Testvorbereitung über die Owner-Rolle). */
async function message(cs: { id: string; patientId: string }, status: string, attempts = 5) {
  const { rows } = await owner.query(
    `INSERT INTO outbox_message (idempotency_key, kind, center_id, patient_id, case_id, rule_version, stage, scheduled_at, status, attempts, last_error)
     VALUES ($1,'erinnerung',$2,$3,$4,'TEST','erinnerung-1', now() - interval '1 day', $5, $6, 'ECONNREFUSED') RETURNING id`,
    [uniqueName('t06-'), C['Z-101'], cs.patientId, cs.id, status, attempts],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  nord = await Client.login('dr.nord');
  doku = await Client.login('doku.nord');
  C = await centerIds(nord);
});
afterAll(() => owner.end());

describe('Versand-Leitstand', () => {
  it('Dead Letter: sichtbar im Zentrum, erneut einreihen nur mit Grund; Versuchsbudget wird erhöht, nicht zurückgesetzt', async () => {
    const cs = await newCase();
    const id = await message(cs, 'dead_letter');
    const list = await doku.get(`/api/v1/dispatch?status=probleme&caseId=${cs.id}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id);
    const item = list.body.items.find((x: { id: string }) => x.id === id);
    expect(item).not.toHaveProperty('email');
    expect(item.pseudonym).toMatch(/^P-/);
    const d = await doku.get(`/api/v1/dispatch/${id}`);
    expect(d.body.actions).toEqual({ requeue: true, cancel: true, reconcile: false });
    expect(d.body.attempts).toBe(5);
    expect(Array.isArray(d.body.journal)).toBe(true);
    expect((await doku.post(`/api/v1/dispatch/${id}/requeue`, {})).status).toBe(400);
    const r = await doku.post(`/api/v1/dispatch/${id}/requeue`, { reason: 'SMTP-Server wieder erreichbar' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = (await owner.query('SELECT status, attempts, max_attempts, handling_note FROM outbox_message WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'ausstehend', attempts: 5, max_attempts: 10, handling_note: 'SMTP-Server wieder erreichbar' });
    const audit = (await owner.query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'versand_erneut_einreihen' AND object_id = $1`, [id])).rows[0].n;
    expect(audit).toBe(1);
    // zweites Einreihen aus „ausstehend“ ist unzulässig
    expect((await doku.post(`/api/v1/dispatch/${id}/requeue`, { reason: 'nochmal' })).status).toBe(409);
  });

  it('unklare Zustellung: nur Abgleich anfordern (kein blindes Neusenden) oder stornieren', async () => {
    const cs = await newCase();
    const id = await message(cs, 'unklar', 2);
    expect((await doku.post(`/api/v1/dispatch/${id}/requeue`, { reason: 'Test' })).status).toBe(409);
    expect((await doku.post(`/api/v1/dispatch/${id}/reconcile`, {})).status).toBe(201);
    const row = (await owner.query('SELECT status, next_attempt_at <= now() AS due FROM outbox_message WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'unklar', due: true });
    expect((await doku.post(`/api/v1/dispatch/${id}/cancel`, { reason: 'Patientin hat Link erhalten' })).status).toBe(201);
    expect((await owner.query('SELECT status, cancel_reason FROM outbox_message WHERE id = $1', [id])).rows[0]).toEqual({ status: 'storniert', cancel_reason: 'Manuell: Patientin hat Link erhalten' });
  });

  it('Abmeldung durch das Zentrum sperrt erneutes Einreihen; unzustellbare Adresse nur nach Adressprüfung reaktivierbar', async () => {
    const cs = await newCase();
    const id = await message(cs, 'dead_letter');
    const put = await doku.put(`/api/v1/cases/${cs.id}/contact-preference`, { emailStatus: 'abgemeldet', reason: 'Telefonisch abbestellt' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.status).toBe('abgemeldet');
    expect((await doku.get(`/api/v1/dispatch/${id}`)).body.actions.requeue).toBe(false);
    expect((await doku.post(`/api/v1/dispatch/${id}/requeue`, { reason: 'Test' })).status).toBe(409);
    // Arzt liest den Status, darf ihn aber nicht ändern
    const g = await nord.get(`/api/v1/cases/${cs.id}/contact-preference`);
    expect(g.body).toMatchObject({ status: 'abgemeldet', source: 'zentrum', canEdit: false });
    expect((await nord.put(`/api/v1/cases/${cs.id}/contact-preference`, { emailStatus: 'aktiv', reason: 'Test' })).status).toBe(403);
    // Worker hat die Adresse als unzustellbar markiert
    await owner.query(`UPDATE contact_preference SET email_status = 'unzustellbar', source = 'versand' WHERE patient_id = $1`, [cs.patientId]);
    expect((await doku.put(`/api/v1/cases/${cs.id}/contact-preference`, { emailStatus: 'aktiv', reason: 'Neue Adresse erfasst' })).status).toBe(409);
    const ok = await doku.put(`/api/v1/cases/${cs.id}/contact-preference`, { emailStatus: 'aktiv', reason: 'Neue Adresse erfasst', addressChecked: true });
    expect(ok.body.status).toBe('aktiv');
    expect((await doku.post(`/api/v1/dispatch/${id}/requeue`, { reason: 'Adresse korrigiert' })).status).toBe(201);
  });

  it('Patientenportal: E-Mail-Erinnerungen abbestellen und wieder anmelden; Einwilligung bleibt gültig', async () => {
    const cs = await newCase();
    const { patient } = await digitalConsent(nord, cs.patientId);
    expect((await patient.get('/api/v1/portal/me')).body.emailReminders).toBe('aktiv');
    const off = await patient.post('/api/v1/portal/email-reminders', { active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body.emailReminders).toBe('abgemeldet');
    const me = (await patient.get('/api/v1/portal/me')).body;
    expect(me.consents[0].status).toBe('gueltig');
    expect((await doku.get(`/api/v1/cases/${cs.id}/contact-preference`)).body).toMatchObject({ status: 'abgemeldet', source: 'portal' });
    expect((await patient.post('/api/v1/portal/email-reminders', { active: true })).body.emailReminders).toBe('aktiv');
    await owner.query(`UPDATE contact_preference SET email_status = 'unzustellbar' WHERE patient_id = $1`, [cs.patientId]);
    expect((await patient.post('/api/v1/portal/email-reminders', { active: true })).status).toBe(409);
  });

  it('Rechte: Arzt, Technik und Forschung ohne Leitstand; zentrale Administration nur Anzahlen ohne Patientenbezug', async () => {
    for (const u of ['dr.nord', 'technik', 'forschung']) expect((await (await Client.login(u)).get('/api/v1/dispatch')).status, u).toBe(403);
    const leitung = await Client.login('leitung.nord');
    expect((await leitung.get('/api/v1/dispatch')).status).toBe(200);
    const admin = await Client.login('admin');
    expect((await admin.get('/api/v1/dispatch')).status).toBe(403);
    const s = await admin.get('/api/v1/dispatch/summary');
    expect(s.status).toBe(200);
    expect(s.body.ebene).toBe('zentral');
    for (const r of s.body.byCenter) expect(Object.keys(r).sort()).toEqual(['center_code', 'center_name', 'n', 'status']);
    const z = await doku.get('/api/v1/dispatch/summary');
    expect(z.body.ebene).toBe('zentrum');
    expect(z.body.problems).toBeGreaterThan(0);
  });

  it('RLS: fremdes Zentrum sieht die Nachricht nicht', async () => {
    const cs = await newCase();
    const id = await message(cs, 'dead_letter');
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.center_ids', $1, true)`, [`{${(await centerIds(await Client.login('dr.sued')))['Z-102']}}`]);
      expect((await c.query('SELECT id FROM outbox_message WHERE id = $1', [id])).rows).toEqual([]);
      expect((await c.query('SELECT patient_id FROM contact_preference')).rows.every((r) => r.patient_id !== cs.patientId)).toBe(true);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await pool.end();
    }
  });
});
