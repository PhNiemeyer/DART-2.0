import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { caseBody, centerIds, Client, consentDocId, digitalConsent, EICAR, PDF } from './client';

/**
 * T02 – End-to-End-Abnahmefälle gegen die laufende API (synthetische Fixtures).
 * Voraussetzung: Datenbanken, Vault und API laufen (siehe README, Abschnitt „Tests“).
 */
let nord: Client;
let nord2: Client;
let sued: Client;
let doku: Client;
let C: Record<string, string>;
let CS: Record<string, string>;

beforeAll(async () => {
  nord = await Client.login('dr.nord');
  nord2 = await Client.login('dr.nord2');
  sued = await Client.login('dr.sued');
  doku = await Client.login('doku.nord');
  C = await centerIds(nord);
  CS = await centerIds(sued);
});

async function createCase(c: Client, center: string, over: Record<string, unknown> = {}) {
  const r = await c.post('/api/v1/cases', caseBody(center, over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; patientId: string; caseNo: string; activated: boolean; gate: string | null };
}

async function caseDetail(c: Client, id: string) {
  const r = await c.get(`/api/v1/cases/${id}`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('T02-1 Zwei Zentren, keinerlei Querzugriff', () => {
  it('fremde Zentren sehen weder Fall, Identität, Bögen noch Listeneinträge', async () => {
    const cs = await createCase(nord, C['Z-101']);
    await digitalConsent(nord, cs.patientId);
    const d = await caseDetail(nord, cs.id);
    const respId = d.responses.find((r: { audience: string }) => r.audience === 'arzt').id;
    expect((await sued.get(`/api/v1/cases/${cs.id}`)).status).toBe(404);
    expect((await sued.get(`/api/v1/cases/${cs.id}/identity`)).status).toBe(404);
    expect((await sued.get(`/api/v1/responses/${respId}`)).status).toBe(404);
    expect((await sued.patch(`/api/v1/responses/${respId}/draft`, { answers: {} }, { 'if-match': '1' })).status).toBe(404);
    const list = await sued.get(`/api/v1/cases?pageSize=100&q=${cs.caseNo}`);
    expect(list.body.items).toEqual([]);
    // Zentrumszuordnung nicht ungeprüft aus dem Request übernehmen
    expect((await sued.post('/api/v1/cases', caseBody(C['Z-101']))).status).toBe(403);
    expect((await sued.get(`/api/v1/cases?centerId=${C['Z-101']}`)).status).toBe(404);
    // Klarnamensuche über den Vault bleibt zentrumsbegrenzt
    const ident = await nord.get(`/api/v1/cases/${cs.id}/identity`);
    const search = await sued.post('/api/v1/patients/search-by-name', { lastName: ident.body.lastName });
    expect(search.body.items).toEqual([]);
  });

  it('technischer Betrieb hat keinen fachlichen Lesezugriff', async () => {
    const t = await Client.login('technik');
    expect((await t.get('/api/v1/cases')).status).toBe(403);
    expect((await t.get('/api/v1/reports/center')).status).toBe(403);
  });

  it('RLS: Laufzeitrolle ohne Zentrumskontext sieht keine Fachdaten', async () => {
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    try {
      const c = await pool.connect();
      const n = await c.query('SELECT count(*)::int AS n FROM treatment_case');
      expect(n.rows[0].n).toBe(0);
      const roles = await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.center_ids', $1, true)`, [`{${CS['Z-102']}}`]);
      const foreign = await c.query('SELECT count(*)::int AS n FROM treatment_case WHERE center_id = $1', [C['Z-101']]);
      expect(foreign.rows[0].n).toBe(0);
      await expect(c.query(`INSERT INTO patient (center_id, pseudonym, vault_ref) VALUES ($1, 'P-RLSTEST1', gen_random_uuid())`, [C['Z-101']])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      c.release();
    } finally {
      await pool.end();
    }
  });
});

describe('T02-2 Ein Patient, zwei Fälle, getrennte Zeitachsen', () => {
  it('zweiter Fall am rechten Knie teilt keine Antwortinstanz oder Zeitachse', async () => {
    const a = await createCase(nord, C['Z-101'], { plannedOpDate: '2026-10-05' });
    await digitalConsent(nord, a.patientId);
    const b = await createCase(nord, C['Z-101'], { patient: { existingPatientId: a.patientId }, side: 'rechts', treatmentType: 'konservativ', plannedOpDate: undefined, conservativeStartDate: '2026-11-20' });
    expect(b.activated).toBe(true);
    const da = await caseDetail(nord, a.id);
    const db = await caseDetail(nord, b.id);
    expect(da.events.find((e: { timepoint: string }) => e.timepoint === 'M6').due_date).toBe('2027-04-05');
    expect(db.events.find((e: { timepoint: string }) => e.timepoint === 'M6').due_date).toBe('2027-05-20');
    expect(db.events[0].reference_kind).toBe('konservativ');
    const idsA = new Set(da.events.map((e: { id: string }) => e.id));
    expect(db.events.some((e: { id: string }) => idsA.has(e.id))).toBe(false);
    const respA = new Set(da.responses.map((r: { id: string }) => r.id));
    expect(db.responses.some((r: { id: string }) => respA.has(r.id))).toBe(false);
    expect(da.otherCases.map((x: { id: string }) => x.id)).toContain(b.id);
    // Anderes Zentrum darf den Patienten nicht für einen Fall verwenden
    expect((await sued.post('/api/v1/cases', caseBody(CS['Z-102'], { patient: { existingPatientId: a.patientId } }))).status).toBe(404);
  });
});

describe('T02-3 Knie Basic sowie kombinierter Science-Knorpel-/DEKOR-Fall', () => {
  it('Basic erhält die Basic-Basis; Science kombiniert Basis (einmal) + Knorpel + DEKOR', async () => {
    const basic = await createCase(nord, C['Z-101']);
    await digitalConsent(nord, basic.patientId);
    const bd = await caseDetail(nord, basic.id);
    expect(bd.responses.filter((r: { audience: string }) => r.audience === 'arzt').map((r: { questionnaire_code: string }) => r.questionnaire_code)).toEqual(['KNIE-BASIC-ARZT']);

    const sci = await createCase(nord, C['Z-101'], {
      mode: 'science',
      registers: ['DART', 'KNORPEL_DGOU', 'DEKOR'],
      modules: ['KNORPEL', 'OSTEOTOMIE'],
      procedures: [
        { code: '5-801', version: 'OPS-BEISPIEL-2026', concept: 'KNORPEL_ZELLTRANSPLANTATION' },
        { code: '5-781', version: 'OPS-BEISPIEL-2026', concept: 'TIBIAKOPF_OSTEOTOMIE' },
      ],
    });
    expect(sci.activated).toBe(false);
    // Einwilligung ohne Science-Umfang reicht nicht
    await digitalConsent(nord, sci.patientId, ['register_basic', 'knorpelregister', 'dekor']);
    expect((await caseDetail(nord, sci.id)).case.status).toBe('consent_ausstehend');
    // Neue Einwilligung mit vollem Umfang
    await digitalConsent(nord, sci.patientId, ['register_basic', 'science', 'knorpelregister', 'dekor', 'kontakt_followup']);
    const sd = await caseDetail(nord, sci.id);
    expect(sd.case.status).toBe('aktiv');
    const codes = sd.responses.filter((r: { audience: string }) => r.audience === 'arzt').map((r: { questionnaire_code: string }) => r.questionnaire_code).sort();
    expect(codes).toEqual(['DEKOR-OSTEOTOMIE-ARZT', 'KNIE-BA-ARZT', 'KNIE-KNORPEL-ARZT']);
    expect(sd.procedures).toHaveLength(2);
  });

  it('Science ohne Zentrumsfreigabe wird abgelehnt', async () => {
    const r = await sued.post('/api/v1/cases', caseBody(CS['Z-102'], { mode: 'science' }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SCIENCE_NICHT_FREIGEGEBEN');
  });
});

describe('T02-4 Fehlende, abgelehnte und ungeklärte Einwilligung sperren die Erhebung', () => {
  it('fehlend: keine Bögen, keine Zeitachse', async () => {
    const cs = await createCase(nord, C['Z-101']);
    expect(cs.activated).toBe(false);
    const d = await caseDetail(nord, cs.id);
    expect(d.responses).toEqual([]);
    expect(d.events).toEqual([]);
  });

  it('abgelehnt (Patient verweigert Teilnahme) und abgelehnter Papiernachweis sperren', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const docId = await consentDocId(nord);
    const prep = await nord.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'digital_demo' });
    const p = new Client();
    await p.post('/api/v1/portal/redeem', { token: prep.body.onsite.token });
    await p.post('/api/v1/portal/verify', { code: prep.body.onsite.accessCode });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    const s = await p.post(`/api/v1/portal/consents/${prep.body.id}/sign`, { acceptedScopes: [], confirmRead: true, signature: { kind: 'getippt', typedName: 'Erika Test' }, signedDate: today });
    expect(s.body.status).toBe('abgelehnt');
    expect((await caseDetail(nord, cs.id)).case.status).toBe('consent_ausstehend');

    const paper = await nord.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'papier_upload' });
    expect(paper.status).toBe(201);
    await nord.post(`/api/v1/consents/${paper.body.id}/evidence`, { fileName: 'scan.pdf', contentType: 'application/pdf', contentBase64: PDF });
    const rej = await nord2.post(`/api/v1/consents/${paper.body.id}/review`, { decision: 'abgelehnt', checklist: { richtige_person: true, vollstaendig: false, richtige_version: true, unterschrift_vorhanden: true }, rejectionReason: 'Seite 2 fehlt (synthetischer Test)' });
    expect(rej.body.status).toBe('abgelehnt');
    expect((await caseDetail(nord, cs.id)).responses).toEqual([]);
  });

  it('historisch ungeklärt sperrt und wird nie zur neuen Unterschrift', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const owner = new Pool({ connectionString: process.env.SEED_DATABASE_URL });
    try {
      await owner.query(`INSERT INTO consent_record (center_id, patient_id, status, method, scopes) VALUES ($1,$2,'historisch_ungeklaert','altbestand','{register_basic}')`, [C['Z-101'], cs.patientId]);
    } finally {
      await owner.end();
    }
    const d = await caseDetail(nord, cs.id);
    expect(d.case.status).toBe('consent_ausstehend');
    expect(d.consents[0].status).toBe('historisch_ungeklaert');
  });
});

describe('T02-5 Digitale Demo-Signatur und Papierupload mit getrennter Prüfung', () => {
  it('digitaler Weg: Token einmalig, Zugangscode nötig, Ergebnis gültig mit Beweispaket und Kopie', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const docId = await consentDocId(nord);
    const prep = await nord.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'digital_demo' });
    const p = new Client();
    // Linkscanner (GET) verbraucht nichts
    expect((await p.get(`/api/v1/portal/redeem?token=${prep.body.onsite.token}`)).status).toBe(404);
    expect((await p.post('/api/v1/portal/redeem', { token: prep.body.onsite.token })).status).toBe(201);
    // Einmalig
    expect((await new Client().post('/api/v1/portal/redeem', { token: prep.body.onsite.token })).status).toBe(400);
    // Ohne Zugangscode kein Zugriff
    expect((await p.get('/api/v1/portal/me')).status).toBe(401);
    expect((await p.post('/api/v1/portal/verify', { code: 'FALSCH99' })).body.ok).toBe(false);
    expect((await p.post('/api/v1/portal/verify', { code: prep.body.onsite.accessCode })).body.ok).toBe(true);
    const me = await p.get('/api/v1/portal/me');
    expect(me.body.consents[0].status).toBe('signatur_ausstehend');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const s = await p.post(`/api/v1/portal/consents/${prep.body.id}/sign`, { acceptedScopes: ['register_basic'], confirmRead: true, signature: { kind: 'gezeichnet', pngDataUrl: png }, signedDate: today });
    expect(s.body.status).toBe('gueltig');
    const copy = await p.get(`/api/v1/portal/consents/${prep.body.id}/copy`);
    expect(copy.body.nachweis.verfahren).toBe('digital_demo');
    expect(copy.body.nachweis.hinweis).toMatch(/keine qualifizierte elektronische Signatur/);
    expect(copy.body.nachweis.informationstext).toMatch(/DEMONSTRATIONSTEXT/);
    expect((await caseDetail(nord, cs.id)).case.status).toBe('aktiv');
  });

  it('Papierweg: Typ-/Malwareprüfung, Upload allein nicht gültig, Prüfliste erforderlich', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const docId = await consentDocId(nord);
    const prep = await doku.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'papier_upload' });
    expect(prep.status).toBe(201);
    const exe = await doku.post(`/api/v1/consents/${prep.body.id}/evidence`, { fileName: 'x.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('MZ\x90\x00binary').toString('base64') });
    expect(exe.status).toBe(422);
    const mal = await doku.post(`/api/v1/consents/${prep.body.id}/evidence`, { fileName: 'virus.pdf', contentType: 'application/pdf', contentBase64: EICAR });
    expect(mal.status).toBe(422);
    expect(mal.body.message).toMatch(/Schadsoftware/);
    const ok = await doku.post(`/api/v1/consents/${prep.body.id}/evidence`, { fileName: 'scan.pdf', contentType: 'application/pdf', contentBase64: PDF }, { 'idempotency-key': `up-${prep.body.id}` });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('upload_in_pruefung');
    // Wiederholte Upload-Finalisierung mit gleichem Key: identische Antwort, kein zweiter Upload
    const again = await doku.post(`/api/v1/consents/${prep.body.id}/evidence`, { fileName: 'scan.pdf', contentType: 'application/pdf', contentBase64: PDF }, { 'idempotency-key': `up-${prep.body.id}` });
    expect(again.body).toEqual(ok.body);
    expect((await caseDetail(nord, cs.id)).case.status).toBe('consent_ausstehend');
    // Dokumentationskraft darf nicht prüfen
    expect((await doku.post(`/api/v1/consents/${prep.body.id}/review`, { decision: 'gueltig', checklist: { richtige_person: true, vollstaendig: true, richtige_version: true, unterschrift_vorhanden: true }, signedDate: '2026-10-01' })).status).toBe(403);
    const incomplete = await nord.post(`/api/v1/consents/${prep.body.id}/review`, { decision: 'gueltig', checklist: { richtige_person: true, vollstaendig: true, richtige_version: true, unterschrift_vorhanden: false }, signedDate: '2026-10-01' });
    expect(incomplete.status).toBe(400);
    const file = await nord.get(`/api/v1/consents/${prep.body.id}/evidence/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toMatch(/no-store/);
    expect((await sued.get(`/api/v1/consents/${prep.body.id}/evidence/file`)).status).toBe(404);
    const good = await nord.post(`/api/v1/consents/${prep.body.id}/review`, { decision: 'gueltig', checklist: { richtige_person: true, vollstaendig: true, richtige_version: true, unterschrift_vorhanden: true }, signedDate: '2026-10-01' });
    expect(good.body.status).toBe('gueltig');
    const consents = (await caseDetail(nord, cs.id)).consents;
    const rec = consents.find((x: { id: string }) => x.id === prep.body.id);
    expect(rec.signed_date).toBe('2026-10-01');
    expect(rec.uploaded_at).toBeTruthy();
    expect(rec.reviewed_at).toBeTruthy();
    expect(rec.uploaded_at).not.toBe(rec.reviewed_at);
  });
});

describe('T02-6 Widerruf verhindert wartenden Versand und Zugriff', () => {
  it('Widerruf im Portal storniert Outbox, sperrt Token/Sitzung und Erfassung', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const { consentId, patient } = await digitalConsent(nord, cs.patientId, ['register_basic', 'kontakt_followup']);
    let d = await caseDetail(nord, cs.id);
    // Der laufende Worker (Abfrage alle 5 s) kann die fällige Einladung bereits versendet haben – das ist zulässig.
    expect(d.outbox.some((o: { kind: string; status: string }) => o.kind === 'einladung' && ['ausstehend', 'in_versand', 'versendet'].includes(o.status))).toBe(true);
    const w = await patient.post(`/api/v1/portal/consents/${consentId}/withdraw`, { confirm: true });
    expect(w.body.status).toBe('widerrufen');
    // Kurzzeitige „in_versand“-Zustände abwarten: Der Worker prüft die Einwilligung unmittelbar vor dem Versand und storniert.
    for (let i = 0; i < 20; i++) {
      d = await caseDetail(nord, cs.id);
      if (!d.outbox.some((o: { status: string }) => o.status === 'in_versand')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(d.outbox.filter((o: { status: string }) => o.status === 'ausstehend')).toEqual([]);
    // Alles nicht bereits Versendete ist storniert; bereits versandte E-Mails sind nicht rückholbar (Lastenheft F15)
    expect(d.outbox.every((o: { status: string }) => o.status === 'storniert' || o.status === 'versendet')).toBe(true);
    expect(d.outbox.some((o: { status: string }) => o.status === 'storniert')).toBe(true);
    expect(d.events.every((e: { status: string }) => e.status === 'gesperrt')).toBe(true);
    expect((await patient.get('/api/v1/portal/me')).status).toBe(401);
    const resp = d.responses.find((r: { audience: string }) => r.audience === 'arzt');
    const save = await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { bas_vorop: { value: 'nein' } } }, { 'if-match': '1' });
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('CONSENT_FEHLT');
  });
});

describe('T02-7 Version 2 ändert historische Version 1 nicht', () => {
  it('Vier-Augen-Veröffentlichung; alter Bogen bleibt V1, neuer Fall erhält V2', async () => {
    const cs = await createCase(nord, C['Z-101']);
    await digitalConsent(nord, cs.patientId);
    const oldResp = (await caseDetail(nord, cs.id)).responses.find((r: { questionnaire_code: string }) => r.questionnaire_code === 'KNIE-MENISKUS-ARZT' || r.questionnaire_code === 'KNIE-BASIC-ARZT');
    const red = await Client.login('redaktion');
    const fr = await Client.login('freigabe');
    const qs = (await red.get('/api/v1/questionnaires')).body.items;
    const q = qs.find((x: { code: string }) => x.code === 'KNIE-BASIC-ARZT');
    const nv = await red.post(`/api/v1/questionnaires/${q.id}/versions`);
    expect(nv.status).toBe(201);
    const v = await red.get(`/api/v1/form-versions/${nv.body.versionId}`);
    const schema = v.body.schema;
    const marker = `überarbeitet (Beispiel V${nv.body.version})`;
    schema.sections[0].items[0].label = `Voroperationen am betroffenen Knie – ${marker}`;
    expect((await red.put(`/api/v1/form-versions/${nv.body.versionId}`, { schema, changeNote: 'Test V2' })).status).toBe(200);
    // Ungültiges Schema (Zyklus) kann nicht zur Prüfung
    const bad = JSON.parse(JSON.stringify(schema));
    bad.sections[0].items[0].visibleIf = { exists: 'bas_vorop_anzahl' };
    await red.put(`/api/v1/form-versions/${nv.body.versionId}`, { schema: bad });
    const badSubmit = await red.post(`/api/v1/form-versions/${nv.body.versionId}/submit-review`);
    expect(badSubmit.status).toBe(422);
    expect(JSON.stringify(badSubmit.body.details)).toMatch(/Zyklische Abhängigkeit/);
    await red.put(`/api/v1/form-versions/${nv.body.versionId}`, { schema });
    expect((await red.post(`/api/v1/form-versions/${nv.body.versionId}/submit-review`)).status).toBe(201);
    expect((await red.post(`/api/v1/form-versions/${nv.body.versionId}/approve`)).status).toBe(403);
    expect((await fr.post(`/api/v1/form-versions/${nv.body.versionId}/approve`)).status).toBe(201);
    expect((await fr.post(`/api/v1/form-versions/${nv.body.versionId}/publish`)).status).toBe(201);
    const old = await nord.get(`/api/v1/responses/${oldResp.id}`);
    expect(old.body.questionnaire.version).toBe(oldResp.version);
    expect(old.body.questionnaire.version).toBeLessThan(nv.body.version);
    expect(old.body.schema.sections[0].items[0].label).not.toContain(marker);
    const cs2 = await createCase(nord, C['Z-101']);
    await digitalConsent(nord, cs2.patientId);
    const newResp = (await caseDetail(nord, cs2.id)).responses.find((r: { questionnaire_code: string }) => r.questionnaire_code === 'KNIE-BASIC-ARZT');
    expect(newResp.version).toBe(nv.body.version);
    expect((await nord.get(`/api/v1/responses/${newResp.id}`)).body.schema.sections[0].items[0].label).toContain(marker);
    // Veröffentlichte Version ist auf DB-Ebene unveränderlich
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    try {
      await expect(pool.query(`UPDATE questionnaire_version SET schema = '{}'::jsonb WHERE id = $1`, [nv.body.versionId])).rejects.toThrow(/unveränderlich/);
    } finally {
      await pool.end();
    }
  });
});

describe('T02-8 Ausgeblendete Antworten bleiben historisch erhalten und gehen nicht in Scores ein', () => {
  it('DEKOR-Verzweigung: ausgeblendeter Wert bleibt gespeichert und inaktiv', async () => {
    const cs = await createCase(nord, C['Z-101'], { mode: 'science', registers: ['DART', 'DEKOR'], modules: ['OSTEOTOMIE'] });
    await digitalConsent(nord, cs.patientId, ['register_basic', 'science', 'dekor']);
    const resp = (await caseDetail(nord, cs.id)).responses.find((r: { questionnaire_code: string }) => r.questionnaire_code === 'DEKOR-OSTEOTOMIE-ARZT');
    let s = await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { dek_art: { value: 'open' }, dek_platte: { value: 'Beispielplatte' }, dek_winkel: { value: 87 }, dek_methode: { value: 'ganzbein' }, dek_korrektur: { value: 8.5 } } }, { 'if-match': String(resp.revision) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    s = await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { dek_art: { value: 'closed' } } }, { 'if-match': String(s.body.revision) });
    const g = await nord.get(`/api/v1/responses/${resp.id}`);
    expect(g.body.answers.dek_platte).toEqual({ value: 'Beispielplatte' });
    expect(g.body.storedInactiveKeys).toContain('dek_platte');
    expect(g.body.evaluation.visibleKeys).not.toContain('dek_platte');
    const sub = await nord.post(`/api/v1/responses/${resp.id}/submit`, {}, { 'if-match': String(s.body.revision) });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const hist = await nord.get(`/api/v1/responses/${resp.id}/history`);
    expect(hist.body.revisions.find((r: { action: string }) => r.action === 'abschluss').inactive_keys).toContain('dek_platte');
  });

  it('Patientenbogen: Demonstrationsscore aus aktiven Antworten (4, 2, 3, verweigert → 75)', async () => {
    const cs = await createCase(nord, C['Z-101'], { plannedOpDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()) });
    const { patient } = await digitalConsent(nord, cs.patientId);
    const me = await patient.get('/api/v1/portal/me');
    const bl = me.body.surveys[0].events.find((e: { timepoint: string }) => e.timepoint === 'BL');
    expect(bl.open).toBe(true);
    const r = await patient.get(`/api/v1/portal/responses/${bl.responseId}`);
    const s = await patient.patch(`/api/v1/portal/responses/${bl.responseId}/draft`, { answers: { pq1: { value: '4' }, pq2: { value: '2' }, pq3: { value: '3' }, pq4: { missing: 'verweigert' }, psport: { value: 'ja' }, psport_art: { value: 'Radfahren' } } }, { 'if-match': String(r.body.revision) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const s2 = await patient.patch(`/api/v1/portal/responses/${bl.responseId}/draft`, { answers: { psport: { value: 'nein' } } }, { 'if-match': String(s.body.revision) });
    const sub = await patient.post(`/api/v1/portal/responses/${bl.responseId}/submit`, {}, { 'if-match': String(s2.body.revision) });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.scores[0].value).toBe(75);
    // Patient darf keinen Arztbogen lesen
    const arzt = (await caseDetail(nord, cs.id)).responses.find((x: { audience: string }) => x.audience === 'arzt');
    expect((await patient.get(`/api/v1/portal/responses/${arzt.id}`)).status).toBe(404);
  });
});

describe('T02-9 Paralleles Autosave meldet Konflikt', () => {
  it('zweite Änderung mit veralteter Revision → 409 mit Serverstand; fehlendes If-Match → 428', async () => {
    const cs = await createCase(nord, C['Z-101']);
    await digitalConsent(nord, cs.patientId);
    const resp = (await caseDetail(nord, cs.id)).responses.find((r: { audience: string }) => r.audience === 'arzt');
    const a = await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { bas_vorop: { value: 'ja' } } }, { 'if-match': '1' });
    expect(a.status).toBe(200);
    const b = await nord2.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { bas_vorop: { value: 'nein' } } }, { 'if-match': '1' });
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('KONFLIKT');
    expect(b.body.serverAnswers.bas_vorop).toEqual({ value: 'ja' });
    expect(b.body.currentRevision).toBe(2);
    expect((await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: {} })).status).toBe(428);
    // Dokumentationskraft darf speichern, aber nicht abschließen
    const d = await doku.patch(`/api/v1/responses/${resp.id}/draft`, { answers: { bas_vorop_anzahl: { value: 2 }, bas_asa: { value: '2' } } }, { 'if-match': '2' });
    expect(d.status).toBe(200);
    expect((await doku.post(`/api/v1/responses/${resp.id}/submit`, {}, { 'if-match': '3' })).status).toBe(403);
    const sub = await nord.post(`/api/v1/responses/${resp.id}/submit`, {}, { 'if-match': '3', 'idempotency-key': `sub-${resp.id}` });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const again = await nord.post(`/api/v1/responses/${resp.id}/submit`, {}, { 'if-match': '3', 'idempotency-key': `sub-${resp.id}` });
    expect(again.body).toEqual(sub.body);
    // Abgeschlossen: kein stilles Überschreiben, Wiederöffnung nur mit Begründung
    expect((await nord.patch(`/api/v1/responses/${resp.id}/draft`, { answers: {} }, { 'if-match': '4' })).status).toBe(409);
    expect((await nord.post(`/api/v1/responses/${resp.id}/reopen`, { reason: '' })).status).toBe(400);
    expect((await nord.post(`/api/v1/responses/${resp.id}/reopen`, { reason: 'Korrektur nach Rückfrage (Test)' })).status).toBe(201);
  });
});

describe('Weitere Prüfungen (T01/T04)', () => {
  it('Idempotency-Key bei Fallanlage dedupliziert', async () => {
    const body = caseBody(C['Z-101']);
    const k = `case-${Date.now()}`;
    const a = await nord.post('/api/v1/cases', body, { 'idempotency-key': k });
    const b = await nord.post('/api/v1/cases', body, { 'idempotency-key': k });
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    const c = await nord.post('/api/v1/cases', { ...body, side: 'rechts' }, { 'idempotency-key': k });
    expect(c.status).toBe(422);
  });

  it('CSRF-Header erforderlich, deutsche Fehlermeldungen mit request_id', async () => {
    const r = await fetch(`${process.env.API_URL ?? 'http://localhost:4000'}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"dr.nord"}' });
    expect(r.status).toBe(403);
    const v = await nord.post('/api/v1/cases', { centerId: 'x' });
    expect(v.status).toBe(400);
    expect(v.body.message).toMatch(/ungültig|unvollständig/);
    expect(v.body.request_id).toBeTruthy();
    expect(JSON.stringify(v.body)).not.toMatch(/stack|at Object/);
  });

  it('Datumskorrektur plant nur offene Termine neu und wird auditiert', async () => {
    const cs = await createCase(nord, C['Z-101'], { plannedOpDate: '2026-01-31' });
    await digitalConsent(nord, cs.patientId);
    let d = await caseDetail(nord, cs.id);
    expect(d.events.find((e: { timepoint: string }) => e.timepoint === 'M6').due_date).toBe('2026-07-31');
    const r = await nord.post(`/api/v1/cases/${cs.id}/dates`, { actualOpDate: '2026-02-02', reason: 'OP verschoben (Test)', revision: d.case.revision });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    d = await caseDetail(nord, cs.id);
    expect(d.events.find((e: { timepoint: string }) => e.timepoint === 'M6').due_date).toBe('2026-08-02');
    expect(d.events[0].reference_kind).toBe('op_tatsaechlich');
    const stale = await nord.post(`/api/v1/cases/${cs.id}/dates`, { actualOpDate: '2026-02-03', reason: 'veraltete Revision', revision: 1 });
    expect(stale.status).toBe(409);
  });

  it('abgelaufener/ungültiger Link und Zugangscode-Sperre nach 5 Fehlversuchen', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const docId = await consentDocId(nord);
    const prep = await nord.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'digital_demo' });
    expect((await new Client().post('/api/v1/portal/redeem', { token: 'x'.repeat(43) })).status).toBe(400);
    const p = new Client();
    await p.post('/api/v1/portal/redeem', { token: prep.body.onsite.token });
    for (let i = 0; i < 5; i++) await p.post('/api/v1/portal/verify', { code: 'FALSCH00' });
    const after = await p.post('/api/v1/portal/verify', { code: prep.body.onsite.accessCode });
    expect(after.status).toBe(401);
  });
});

describe('F19 Exportfreigabe (zweckgebunden, Vier-Augen)', () => {
  it('Antrag durch Forschung, keine Selbstgenehmigung, Download nur für Antragsteller, Prüfsummen', async () => {
    const fo = await Client.login('forschung');
    const admin = await Client.login('admin');
    const req = await fo.post('/api/v1/exports', { purpose: 'Synthetischer Testexport zur Abnahme', scope: 'basic', periodFrom: '2026-01-01', periodTo: '2026-12-31', layers: ['normalisiert', 'scores'] });
    expect(req.status).toBe(201);
    expect((await fo.post(`/api/v1/exports/${req.body.id}/decide`, { decision: 'genehmigt', note: 'Selbstgenehmigung' })).status).toBe(403);
    expect((await nord.post('/api/v1/exports', { purpose: 'Arzt darf nicht exportieren', scope: 'basic', periodFrom: '2026-01-01', periodTo: '2026-12-31', layers: ['scores'] })).status).toBe(403);
    expect((await admin.post(`/api/v1/exports/${req.body.id}/decide`, { decision: 'genehmigt', note: 'Zweck geprüft (Test)' })).status).toBe(201);
    // Worker (laufender Prozess) erstellt den Export asynchron
    let job: any;
    for (let i = 0; i < 30; i++) {
      job = (await fo.get('/api/v1/exports')).body.items.find((x: { id: string }) => x.id === req.body.id);
      if (job.status === 'fertig' || job.status === 'fehler') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(job.status, JSON.stringify(job.result_summary)).toBe('fertig');
    const names = job.files.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(['faelle.csv', 'antworten.csv', 'scores.csv', 'datenwoerterbuch.csv', 'manifest.json']));
    const dl = await fo.get(`/api/v1/exports/${req.body.id}/files/manifest.json`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('x-checksum-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect((await admin.get(`/api/v1/exports/${req.body.id}/files/manifest.json`)).status).toBe(404);
  });
});

describe('T04 Abgelaufener Link', () => {
  it('abgelaufener Einladungstoken wird abgelehnt und als abgelaufen markiert', async () => {
    const cs = await createCase(nord, C['Z-101']);
    const docId = await consentDocId(nord);
    const prep = await nord.post('/api/v1/consents', { patientId: cs.patientId, documentVersionId: docId, scopes: ['register_basic'], method: 'digital_demo' });
    const owner = new Pool({ connectionString: process.env.SEED_DATABASE_URL });
    try {
      await owner.query(`UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE patient_id = $1 AND status = 'aktiv'`, [cs.patientId]);
      const r = await new Client().post('/api/v1/portal/redeem', { token: prep.body.onsite.token });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/abgelaufen/);
      const st = await owner.query(`SELECT status FROM invitation WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`, [cs.patientId]);
      expect(st.rows[0].status).toBe('abgelaufen');
    } finally {
      await owner.end();
    }
  });
});
