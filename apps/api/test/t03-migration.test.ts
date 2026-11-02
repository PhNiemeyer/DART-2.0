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

  it('Quellenmanifest meldet fehlende Quellen inkl. erwartetem V05-Hash', async () => {
    const m = (await dm.get('/api/v1/migration/manifest')).body.items;
    const v05 = m.find((x: { source_code: string }) => x.source_code === 'Q03');
    expect(v05.status).toBe('fehlt');
    expect(v05.expected_sha256).toBe('23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b');
  });
});
