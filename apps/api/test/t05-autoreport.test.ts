import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { centerIds, Client } from './client';

/**
 * Autoreport und Benchmarking. Voraussetzung: synthetische Demodaten (node apps/api/dist/demo-daten.js).
 */
let nord: Client;
let sued: Client;

beforeAll(async () => {
  nord = await Client.login('dr.nord');
  sued = await Client.login('dr.sued');
});

const get = (c: Client, qs: string) => c.get(`/api/v1/reports/auto?${qs}`);

describe('Autoreport (eigene Daten vs. Gesamtkollektiv)', () => {
  it('liefert IKDC nach Pathologie mit Kennzeichnung „Freigabe ausstehend“ und konsistenten Ebenen', async () => {
    const r = await get(nord, 'ebene=operateur&score=IKDC@1&timepoint=M12&dimension=modul');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b.score.status).toBe('freigabe_ausstehend');
    expect(b.hinweise.join(' ')).toMatch(/nicht risikoadjustiert/);
    expect(b.alleFaelle.gesamt.n).toBeGreaterThan(0);
    for (const o of [b.alleFaelle, ...b.outcome]) {
      // Operateur ⊆ Zentrum ⊆ Gesamtkollektiv
      expect(o.eigen.n).toBeLessThanOrEqual(o.zentrum?.n ?? o.gesamt.n);
      if (o.zentrum) expect(o.zentrum.n).toBeLessThanOrEqual(o.gesamt.n);
      // Kleingruppen ohne Mittelwert
      if (o.eigen.n < 5) expect(o.eigen.mean).toBeNull();
      if (o.gesamt.n < 5) expect(o.gesamt.mean).toBeNull();
      if (o.vergleich.einordnung !== 'zu_wenige_faelle') expect(o.vergleich.ciLow).toBeLessThanOrEqual(o.vergleich.ciHigh);
    }
    expect(b.verlauf.map((v: { timepoint: string }) => v.timepoint)).toEqual(['BL', 'M6', 'M12', 'M24', 'M36', 'M60']);
  });

  it('das Gesamtkollektiv ist für alle Betrachter gleich; eigene Daten unterscheiden sich', async () => {
    const a = (await get(nord, 'ebene=operateur&score=KOOS-QOL@1&timepoint=M12&dimension=modul')).body;
    const s = (await get(sued, 'ebene=operateur&score=KOOS-QOL@1&timepoint=M12&dimension=modul')).body;
    expect(s.alleFaelle.gesamt).toEqual(a.alleFaelle.gesamt);
    expect(s.alleFaelle.eigen.n).not.toBe(a.alleFaelle.eigen.n);
  });

  it('Veränderung zur Baseline und Zentrumsebene', async () => {
    const d = (await get(nord, 'ebene=zentrum&score=IKDC@1&timepoint=M12&dimension=eingriff&delta=true')).body;
    expect(d.ebenen.zentrum).toBeNull();
    expect(d.verlauf.map((v: { timepoint: string }) => v.timepoint)).not.toContain('BL');
    expect(d.alleFaelle.eigen.mean).toBeGreaterThan(0); // synthetische Verbesserung nach 12 Monaten
  });

  it('Patientencharakteristika: Anteile bezogen auf erfasste Werte, Kleingruppen „< 5“', async () => {
    const b = (await get(nord, 'ebene=operateur&score=IKDC@1&timepoint=M12')).body;
    const sex = b.merkmale.filter((m: { merkmal: string; auspraegung: string }) => m.merkmal === 'geschlecht' && !['nicht erfasst', 'unbekannt'].includes(m.auspraegung));
    const sum = sex.reduce((acc: number, m: { eigen: { anteil: number | null } }) => acc + (m.eigen.anteil ?? 0), 0);
    expect(sum).toBeGreaterThan(95);
    expect(sum).toBeLessThanOrEqual(100.1);
    expect(b.merkmale.some((m: { gesamt: { klein?: boolean; n: number | null } }) => m.gesamt?.klein && m.gesamt.n === null)).toBe(true);
  });

  it('Rechte: Operateur-Ebene nur für Ärzte, kein Zugriff für Technik/Forschung/Dokumentation, fremdes Zentrum verborgen', async () => {
    const daten = await Client.login('daten');
    expect((await get(daten, 'ebene=operateur')).status).toBe(400);
    expect((await get(daten, 'ebene=zentrum')).status).toBe(200);
    for (const u of ['technik', 'forschung', 'doku.nord']) expect((await get(await Client.login(u), 'ebene=zentrum')).status, u).toBe(403);
    const C = await centerIds(nord);
    expect((await get(sued, `ebene=zentrum&centerId=${C['Z-101']}`)).status).toBe(404);
  });

  it('RLS: eigene Auswertungsfunktion liefert für ein fremdes Zentrum nichts; Gesamtfunktion nur aggregiert', async () => {
    const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    const C = await centerIds(nord);
    const CS = await centerIds(sued);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.center_ids', $1, true)`, [`{${CS['Z-102']}}`]);
      const foreign = await c.query(`SELECT * FROM report_scores_raw('IKDC@1','M12','gesamt',NULL,NULL,false,$1,NULL)`, [[C['Z-101']]]);
      expect(foreign.rows).toEqual([]);
      const total = await c.query(`SELECT * FROM report_scores_gesamt('IKDC@1','M12','modul',NULL,NULL,false)`);
      expect(total.rows.length).toBeGreaterThan(0);
      for (const r of total.rows) {
        expect(Object.keys(r).sort()).toEqual(['gruppe', 'mean', 'n', 'sd']);
        if (r.n < 5) expect(r.mean).toBeNull();
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await pool.end();
    }
  });
});
