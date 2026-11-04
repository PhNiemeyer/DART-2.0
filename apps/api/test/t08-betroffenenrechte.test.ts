import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseBody, centerIds, Client, digitalConsent } from './client';

/** Betroffenenrechte (R-19): Fristen, Identitätsprüfung, Auskunft, Einschränkung, vorbereitete Löschung. Synthetische Daten. */
let nord: Client;
let doku: Client;
let leitung: Client;
let C: Record<string, string>;
const owner = new Pool({ connectionString: process.env.SEED_DATABASE_URL });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

async function newCase(withConsent = false) {
  const r = await nord.post('/api/v1/cases', caseBody(C['Z-101']));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (withConsent) await digitalConsent(nord, r.body.patientId);
  return r.body as { id: string; patientId: string };
}

async function request(caseId: string, kind: string, receivedAt = today()) {
  const r = await doku.post('/api/v1/dsr', { caseId, kind, receivedAt, channel: 'schriftlich', note: 'Synthetischer Testantrag' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; dueDate: string };
}

beforeAll(async () => {
  nord = await Client.login('dr.nord');
  doku = await Client.login('doku.nord');
  leitung = await Client.login('leitung.nord');
  C = await centerIds(nord);
});
afterAll(() => owner.end());

describe('Betroffenenrechte (R-19)', () => {
  it('Erfassung durch Dokumentation, Frist ein Monat; Bearbeitung nur durch Zentrumsverantwortliche; Verlauf unveränderlich', async () => {
    const cs = await newCase();
    const r = await request(cs.id, 'berichtigung', '2026-10-15');
    expect(r.dueDate).toBe('2026-11-15');
    expect((await doku.post(`/api/v1/dsr/${r.id}/identity`, { method: 'persoenlich_ausweis' })).status).toBe(403);
    const d = (await doku.get(`/api/v1/dsr/${r.id}`)).body;
    expect(d.actions.close).toBe(false);
    expect((await leitung.get(`/api/v1/dsr/${r.id}`)).body.actions).toMatchObject({ identity: true, extend: true, close: true, restrict: false });
    // Abschluss als „erledigt“ erst nach Identitätsprüfung
    expect((await leitung.post(`/api/v1/dsr/${r.id}/close`, { result: 'erledigt', outcome: 'Anschrift berichtigt' })).status).toBe(409);
    expect((await leitung.post(`/api/v1/dsr/${r.id}/identity`, { method: 'persoenlich_ausweis', note: 'Ausweis vorgelegt' })).status).toBe(201);
    expect((await leitung.post(`/api/v1/dsr/${r.id}/close`, { result: 'erledigt', outcome: 'Geburtsdatum im Vault berichtigt' })).status).toBe(201);
    const done = (await leitung.get(`/api/v1/dsr/${r.id}`)).body;
    expect(done.status).toBe('erledigt');
    expect(done.events.map((e: { action: string }) => e.action)).toEqual(['erfasst', 'identitaet_geprueft', 'abgeschlossen']);
    await expect(owner.query(`UPDATE data_subject_request_event SET detail = 'x' WHERE request_id = $1`, [r.id])).rejects.toThrow(/unveränderlich/);
  });

  it('Fristverlängerung einmalig um zwei Monate mit Begründung, nur innerhalb der Frist; überfällige Anträge werden gelistet', async () => {
    const cs = await newCase();
    const r = await request(cs.id, 'auskunft');
    expect((await leitung.post(`/api/v1/dsr/${r.id}/extend`, { reason: 'kurz' })).status).toBe(400);
    const e = await leitung.post(`/api/v1/dsr/${r.id}/extend`, { reason: 'Umfangreiche Altbestände aus mehreren Registern' });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect((await leitung.post(`/api/v1/dsr/${r.id}/extend`, { reason: 'Noch einmal verlängern' })).status).toBe(409);
    const late = await request(cs.id, 'auskunft', '2026-01-05');
    expect((await leitung.post(`/api/v1/dsr/${late.id}/extend`, { reason: 'Zu spät für eine Verlängerung' })).status).toBe(409);
    const over = (await leitung.get('/api/v1/dsr?status=ueberfaellig')).body.items.map((x: { id: string }) => x.id);
    expect(over).toContain(late.id);
    expect(over).not.toContain(r.id);
    expect((await leitung.get('/api/v1/dsr/summary')).body.ueberfaellig).toBeGreaterThan(0);
  });

  it('Auskunft: vollständiger Bericht erst nach Identitätsprüfung, enthält Identität, Fälle, Einwilligung und Antworten', async () => {
    const cs = await newCase(true);
    const r = await request(cs.id, 'auskunft');
    expect((await leitung.get(`/api/v1/dsr/${r.id}/auskunft`)).status).toBe(409);
    await leitung.post(`/api/v1/dsr/${r.id}/identity`, { method: 'portal_zugangscode' });
    const a = await leitung.get(`/api/v1/dsr/${r.id}/auskunft`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.identitaet.vorname).toBe('Erika');
    expect(a.body.pseudonym).toMatch(/^P-/);
    expect(a.body.faelle).toHaveLength(1);
    expect(a.body.faelle[0]).not.toHaveProperty('id');
    expect(a.body.einwilligungen[0].status).toBe('gueltig');
    expect(Array.isArray(a.body.boegen)).toBe(true);
    expect(a.body.protokollierteZugriffe).toBeGreaterThan(0);
    expect((await doku.get(`/api/v1/dsr/${r.id}/auskunft`)).status).toBe(403);
  });

  it('Einschränkung: sperrt Versand sofort, schließt aus Auswertungen aus und ist wieder aufhebbar', async () => {
    const cs = await newCase(true);
    const pending = (await owner.query(`SELECT count(*)::int AS n FROM outbox_message WHERE patient_id = $1 AND status = 'ausstehend'`, [cs.patientId])).rows[0].n;
    expect(pending).toBeGreaterThan(0);
    const r = await request(cs.id, 'einschraenkung');
    expect((await leitung.post(`/api/v1/dsr/${r.id}/restrict`, { reason: 'Richtigkeit der Daten bestritten' })).status).toBe(409); // erst Identität
    await leitung.post(`/api/v1/dsr/${r.id}/identity`, { method: 'schriftlich_unterschrift' });
    expect((await leitung.post(`/api/v1/dsr/${r.id}/restrict`, { reason: 'Richtigkeit der Daten bestritten' })).status).toBe(201);
    expect((await owner.query(`SELECT count(*)::int AS n FROM outbox_message WHERE patient_id = $1 AND status = 'ausstehend'`, [cs.patientId])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM invitation WHERE patient_id = $1 AND status = 'aktiv'`, [cs.patientId])).rows[0].n).toBe(0);
    // Auswertungsfunktion schließt die Person aus
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.center_ids', $1, true)`, [`{${C['Z-101']}}`]);
      const before = (await c.query(`SELECT n FROM report_characteristics_raw(NULL,NULL,$1,NULL) WHERE merkmal = 'faelle'`, [[C['Z-101']]])).rows[0].n;
      await c.query('UPDATE patient SET restricted_at = NULL WHERE id = $1', [cs.patientId]);
      const after = (await c.query(`SELECT n FROM report_characteristics_raw(NULL,NULL,$1,NULL) WHERE merkmal = 'faelle'`, [[C['Z-101']]])).rows[0].n;
      expect(after).toBe(before + 1);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await pool.end();
    }
    expect((await leitung.get(`/api/v1/dsr/${r.id}`)).body.restriction.byThisRequest).toBe(true);
    expect((await leitung.post(`/api/v1/dsr/${r.id}/lift`, { reason: 'Richtigkeit bestätigt' })).status).toBe(201);
    expect((await owner.query('SELECT restricted_at FROM patient WHERE id = $1', [cs.patientId])).rows[0].restricted_at).toBeNull();
  });

  it('Löschung: nur vorbereitet – Sperre, Übersicht je Datenklasse, Abschluss nur mit Bestätigung der manuellen Löschung', async () => {
    const cs = await newCase(true);
    const r = await request(cs.id, 'loeschung');
    await leitung.post(`/api/v1/dsr/${r.id}/identity`, { method: 'persoenlich_ausweis' });
    const ov = await leitung.get(`/api/v1/dsr/${r.id}/loeschuebersicht`);
    expect(ov.status).toBe(200);
    expect(ov.body.hinweis).toMatch(/nicht automatisch/);
    expect(ov.body.klassen.find((k: { klasse: string }) => k.klasse === 'Behandlungsfälle').anzahl).toBe(1);
    expect(ov.body.klassen.every((k: { entscheidung: string }) => k.entscheidung === 'offen')).toBe(true);
    expect((await leitung.post(`/api/v1/dsr/${r.id}/close`, { result: 'erledigt', outcome: 'Gelöscht nach Matrix' })).status).toBe(409); // erst Sperre
    await leitung.post(`/api/v1/dsr/${r.id}/restrict`, { reason: 'Sofortsperre bis zur Löschung' });
    expect((await leitung.post(`/api/v1/dsr/${r.id}/close`, { result: 'erledigt', outcome: 'Gelöscht nach Matrix' })).status).toBe(409); // Bestätigung fehlt
    expect((await leitung.post(`/api/v1/dsr/${r.id}/close`, { result: 'erledigt', outcome: 'Manuell gelöscht nach Matrix V1 (Protokoll 12)', manualDeletionConfirmed: true })).status).toBe(201);
    // Fall und Daten existieren weiterhin (keine automatische Löschung), aber gesperrt
    expect((await owner.query('SELECT restricted_at IS NOT NULL AS gesperrt FROM patient WHERE id = $1', [cs.patientId])).rows[0].gesperrt).toBe(true);
  });

  it('Rechte: Arzt/Technik ohne Zugriff, zentrale Administration nur Anzahlen, fremdes Zentrum unsichtbar', async () => {
    const cs = await newCase();
    const r = await request(cs.id, 'widerruf');
    for (const u of ['dr.nord', 'technik', 'forschung']) expect((await (await Client.login(u)).get('/api/v1/dsr')).status, u).toBe(403);
    const admin = await Client.login('admin');
    expect((await admin.get(`/api/v1/dsr/${r.id}`)).status).toBe(403);
    const s = (await admin.get('/api/v1/dsr/summary')).body;
    expect(s.ebene).toBe('zentral');
    for (const row of s.byCenter) expect(Object.keys(row).sort()).toEqual(['center_code', 'center_name', 'erledigt', 'kind', 'offen', 'ueberfaellig']);
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.center_ids', $1, true)`, [`{${(await centerIds(await Client.login('dr.sued')))['Z-102']}}`]);
      expect((await c.query('SELECT id FROM data_subject_request WHERE id = $1', [r.id])).rows).toEqual([]);
      expect((await c.query('SELECT id FROM data_subject_request_event WHERE request_id = $1', [r.id])).rows).toEqual([]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await pool.end();
    }
  });
});
