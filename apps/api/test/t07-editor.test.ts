import { FormSchema, ruleFromDraft } from '@dart/forms';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, uniqueName } from './client';

/** Formulareditor (R-10): wiederholbare Gruppen, Verzweigungsassistent, Versionsvergleich. Nur Beispielinhalte. */
let red: Client;
let fr: Client;

beforeAll(async () => {
  red = await Client.login('redaktion');
  fr = await Client.login('freigabe');
});

async function newQuestionnaire() {
  const code = uniqueName('T-ED-').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  const r = await red.post('/api/v1/questionnaires', { code, title: 'Editor-Test (Beispiel)', audience: 'arzt', module: 'BASIS' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { questionnaireId: string; versionId: string };
}

function exampleSchema(code: string): FormSchema {
  return {
    schemaVersion: 1, code, title: 'Editor-Test (Beispiel)', audience: 'arzt', module: 'BASIS',
    sections: [{ id: 'abschnitt_1', title: 'Vorgeschichte', items: [
      { id: 'voroperiert', varId: `${code}_VO`, label: 'Voroperiert (Beispiel)', type: 'yesno' },
      { id: 'eingriffe', varId: `${code}_G`, label: 'Frühere Eingriffe', type: 'group', repeat: { min: 0, max: 3, instanceLabel: 'Eingriff' }, visibleIf: ruleFromDraft({ mode: 'all', conditions: [{ field: 'voroperiert', op: 'gleich', value: 'ja' }] }), items: [
        { id: 'e_art', varId: `${code}_G_ART`, label: 'Art (Beispiel)', type: 'single', codes: [{ code: 'a', label: 'Arthroskopie' }, { code: 'o', label: 'Offen' }, { code: 's', label: 'Sonstige' }] },
        { id: 'e_text', varId: `${code}_G_TXT`, label: 'Beschreibung', type: 'text', visibleIf: ruleFromDraft({ mode: 'all', conditions: [{ field: 'e_art', op: 'gleich', value: 's' }] }) },
      ] },
    ] }],
  };
}

describe('Formulareditor (R-10)', () => {
  it('Gruppe und mit dem Assistenten gebaute Regeln werden gespeichert und bestehen die Prüfung', async () => {
    const q = await newQuestionnaire();
    const v = (await red.get(`/api/v1/form-versions/${q.versionId}`)).body;
    const schema = exampleSchema(v.code);
    expect((await red.put(`/api/v1/form-versions/${q.versionId}`, { schema })).status).toBe(200);
    const saved = (await red.get(`/api/v1/form-versions/${q.versionId}`)).body;
    expect(saved.validation).toEqual([]);
    expect(saved.schema.sections[0].items[1].items).toHaveLength(2);
    // Erste Version: kein Vorgänger
    const d = (await red.get(`/api/v1/form-versions/${q.versionId}/diff`)).body;
    expect(d.basis).toBeNull();
    expect(d.diff).toBeNull();
  });

  it('Versionsvergleich: Vorgängerversion als Standard, kritische Änderungen markiert, nur gleiches Formular', async () => {
    const q = await newQuestionnaire();
    const code = (await red.get(`/api/v1/form-versions/${q.versionId}`)).body.code;
    await red.put(`/api/v1/form-versions/${q.versionId}`, { schema: exampleSchema(code) });
    expect((await red.post(`/api/v1/form-versions/${q.versionId}/submit-review`)).status).toBe(201);
    expect((await fr.post(`/api/v1/form-versions/${q.versionId}/approve`)).status).toBe(201);
    expect((await fr.post(`/api/v1/form-versions/${q.versionId}/publish`)).status).toBe(201);
    const v2 = (await red.post(`/api/v1/questionnaires/${q.questionnaireId}/versions`)).body;
    const s2 = exampleSchema(code);
    const group = s2.sections[0].items[1];
    group.items![0].codes = group.items![0].codes!.filter((c) => c.code !== 'o'); // Code entfernt → kritisch
    group.repeat = { min: 0, max: 5, instanceLabel: 'Eingriff' };
    s2.sections[0].items.push({ id: 'beschwerden', varId: `${code}_BESCHW`, label: 'Beschwerden seit (Beispiel)', type: 'date' });
    expect((await red.put(`/api/v1/form-versions/${v2.versionId}`, { schema: s2 })).status).toBe(200);
    const r = await red.get(`/api/v1/form-versions/${v2.versionId}/diff`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.basis).toMatchObject({ id: q.versionId, version: 1, status: 'veroeffentlicht' });
    expect(r.body.ziel).toMatchObject({ id: v2.versionId, version: 2, status: 'entwurf' });
    expect(r.body.versionen.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect(r.body.diff.anzahl).toMatchObject({ neu: 1, entfernt: 0, geaendert: 2, kritisch: 1 });
    const art = r.body.diff.felder.find((f: { itemId: string }) => f.itemId === 'e_art');
    expect(art.schwere).toBe('kritisch');
    expect(art.ort).toBe('Vorgeschichte › Frühere Eingriffe');
    // Lesezugriff für Freigabe; fremdes Formular als Basis abgelehnt; keine Rechte für Forschung
    expect((await fr.get(`/api/v1/form-versions/${v2.versionId}/diff?gegen=${q.versionId}`)).status).toBe(200);
    const other = await newQuestionnaire();
    expect((await red.get(`/api/v1/form-versions/${v2.versionId}/diff?gegen=${other.versionId}`)).status).toBe(400);
    expect((await (await Client.login('forschung')).get(`/api/v1/form-versions/${v2.versionId}/diff`)).status).toBe(403);
  });
});
