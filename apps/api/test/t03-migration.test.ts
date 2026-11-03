import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from './client';

/** T03 – Migrationstests mit synthetischem Altexport (tests/fixtures/altexport-synthetisch-CA.csv). */
const CSV = readFileSync(join(__dirname, '../../../tests/fixtures/altexport-synthetisch-CA.csv'), 'utf8');
const body = (over: Record<string, unknown> = {}) => ({ fileName: 'altexport-synthetisch-CA.csv', sheet: 'CA', sourceSystem: 'DART-ALT-SYNTH', exportVersion: 'SYNTH-1', csv: CSV, ...over });
let dm: Client;

beforeAll(async () => {
  dm = await Client.login('daten');
  // Vorherige Testläufe zurückrollen, damit der Erstimport reproduzierbar ist
  for (const b of (await dm.get('/api/v1/migration-batches')).body.items) {
    if (b.status === 'importiert' && b.source_system === 'DART-ALT-SYNTH') await dm.post(`/api/v1/migration-batches/${b.id}/rollback`);
  }
});

describe('T03 Migration', () => {
  it('nur Datenmanagement darf migrieren', async () => {
    const nord = await Client.login('dr.nord');
    expect((await nord.post('/api/v1/migration-batches/dry-run', body())).status).toBe(403);
  });

  it('Probelauf: Bilanz geht auf, Fallstricke landen in der Klärungsliste', async () => {
    const r = await dm.post('/api/v1/migration-batches/dry-run', body());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = r.body.summary;
    expect(s.zeilen).toMatchObject({ geliefert: 7, normalisiert: 5, ungeklaert: 2, archiviert: 0, quarantaene: 0, ausgeglichen: true });
    expect(s.werte.ausgeglichen).toBe(true);
    for (const code of ['PID_IST_BELEG_ID', 'ZENTRUM_999', 'VISITCODE_UNBEKANNT', 'CHECKBOX_LEER', 'ALIAS_ABWEICHUNG', 'VARID_MEHRFACH', 'VARID_FEHLT', 'DATUM_UNPLAUSIBEL', 'OPS_KONZEPT_MEHRDEUTIG']) {
      expect(s.hinweise[code], code).toBeGreaterThan(0);
    }
    // Visitcode 8 = FU3 (Codeliste), nicht numerisch
    expect(s.nachZeitpunkt.FU3).toBe(1);
    // Probelauf schreibt keine Zieldaten
    const batch = (await dm.get('/api/v1/migration-batches')).body.items.find((b: { id: string }) => b.id === r.body.batchId);
    expect(batch.records).toBe(0);
  });

  it('Import ist idempotent, Rohwerte zu 100 % nachweisbar, Rollback stellt den Vorzustand her', async () => {
    const a = await dm.post('/api/v1/migration-batches/import', body());
    expect(a.body.summary.import).toEqual({ neu: 7, bereitsVorhanden: 0 });
    const b = await dm.post('/api/v1/migration-batches/import', body());
    expect(b.body.summary.import).toEqual({ neu: 0, bereitsVorhanden: 7 });
    const rep = await dm.get(`/api/v1/migration-batches/${a.body.batchId}/report`);
    expect(rep.body.rohwertNachweis).toEqual({ geprueft: 7, hashKorrekt: 7, vollstaendig: true });
    expect(rep.body.verwaisteWerte).toBe(0);
    // Null ≠ 0: leere Checkbox bleibt leer und ungeklärt, „0“ wird „nein“
    const raucher = rep.body.variablenStatistik.find((v: { column_name: string }) => v.column_name === 'RAUCHER_CB');
    expect(raucher.leer).toBeGreaterThan(0);
    expect(raucher.ungeklaert).toBe(raucher.leer);
    // Formelartiger Freitext bleibt unverändert als Rohwert erhalten
    const issues = (await dm.get(`/api/v1/migration-batches/${a.body.batchId}/issues`)).body.items;
    expect(issues.some((i: { code: string; source_row: number }) => i.code === 'ZENTRUM_999' && i.source_row === 5)).toBe(true);
    const rb = await dm.post(`/api/v1/migration-batches/${a.body.batchId}/rollback`);
    expect(rb.body.entfernteDatensaetze).toBe(7);
    expect((await dm.post(`/api/v1/migration-batches/${a.body.batchId}/rollback`)).status).toBe(409);
    const c = await dm.post('/api/v1/migration-batches/import', body());
    expect(c.body.summary.import).toEqual({ neu: 7, bereitsVorhanden: 0 });
  });

  it('unbekannte Exportversion → Quarantäne (gesichert, nicht normalisiert)', async () => {
    const r = await dm.post('/api/v1/migration-batches/dry-run', body({ exportVersion: 'UNBEKANNT-9' }));
    expect(r.body.summary.zeilen).toMatchObject({ geliefert: 7, quarantaene: 7, ausgeglichen: true });
    expect(r.body.summary.werte.ausgeglichen).toBe(true);
  });

  it('Quellenmanifest: V05 mit erwartetem Hash vorhanden, nicht gelieferte Quellen weiterhin als fehlend gemeldet', async () => {
    const m = (await dm.get('/api/v1/migration/manifest')).body.items;
    const v05 = m.find((x: { source_code: string }) => x.source_code === 'Q03');
    expect(v05.status).toBe('vorhanden');
    expect(v05.expected_sha256).toBe('23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b');
    expect(m.find((x: { source_code: string }) => x.source_code === 'Q08').status).toBe('fehlt');
  });
});

describe('T03 Variablenkatalog V05 (Originalquellen Q02/Q03)', () => {
  it('alle 1.441 Katalogzeilen und 33 Neuanlage-Vorschläge geladen, jede mit expliziter Klasse und Entscheidung, keine erfundene Freigabe', async () => {
    const s = (await dm.get('/api/v1/migration/catalog/summary')).body;
    expect(s.eintraege).toBe(1441);
    expect(s.freigegeben).toBe(0);
    expect(Object.fromEntries(s.nachKlasse.map((x: { klasse: string; n: number }) => [x.klasse, x.n]))).toEqual({ Entfall: 20, Übernahme: 753, Überarbeitung: 668 });
    expect(s.entscheidungen).toEqual([{ entscheidung: 'Vorschlag; fachlich offen', n: 1441 }]);
    expect(s.neuanlage).toHaveLength(33);
    const h = Object.fromEntries(s.hinweise.map((x: { hinweis: string; n: number }) => [x.hinweis, x.n]));
    expect(h['eCRF-/SAS-Alias abweichend']).toBe(285);
    expect(h['VARID fehlt']).toBe(34);
    expect(h['VARID im Blatt mehrfach']).toBe(10);
    expect(h['Leere Checkbox nicht automatisch 0']).toBe(355);
    const m = (await dm.get('/api/v1/migration/manifest')).body.items.find((x: { source_code: string }) => x.source_code === 'Q03');
    expect(m.status).toBe('vorhanden');
    expect(m.actual_sha256).toBe(m.expected_sha256);
  });

  it('Katalogsuche filtert nach Blatt, Klasse und Prüfhinweis', async () => {
    const r = (await dm.get(`/api/v1/migration/catalog?hinweis=${encodeURIComponent('VARID im Blatt mehrfach')}`)).body;
    expect(r.total).toBe(10);
    const c = (await dm.get('/api/v1/migration/catalog?sheet=CA&klasse=C')).body;
    expect(c.total).toBe(13);
    expect(c.items.every((x: { klasse: string }) => x.klasse === 'Entfall')).toBe(true);
  });

  it('Probelauf mit V05-Spalten: ohne Freigabe nichts normalisiert, Rohwerte vollständig bilanziert', async () => {
    const csv = readFileSync(join(__dirname, '../../../tests/fixtures/v05-synthetisch-CA.csv'), 'utf8');
    const r = await dm.post('/api/v1/migration-batches/dry-run', { mapping: 'V05', fileName: 'v05-synthetisch-CA.csv', sheet: 'CA', sourceSystem: 'DART-KNIE-PROD', exportVersion: 'V05', csv });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = r.body.summary;
    expect(s.zeilen).toMatchObject({ geliefert: 3, normalisiert: 0, ungeklaert: 3, ausgeglichen: true });
    expect(s.werte).toMatchObject({ geliefert: 24, erfasst: 24, ausgeglichen: true });
    expect(s.werte.nachErgebnis.archiviert).toBe(3); // CA_SEX: Klasse Entfall
    for (const code of ['MAPPING_NICHT_FREIGEGEBEN', 'PID_IST_BELEG_ID', 'ALIAS_ABWEICHUNG', 'VARID_FEHLT', 'SPALTE_UNGEMAPPT']) expect(s.hinweise[code], code).toBeGreaterThan(0);
  });
});
