import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CatalogEntry, MappingRuleVersion, mappingFromCatalog, MigrationContext, normalizeLegacyRow, NormalizedRow, reconcile, RowOutcome, SYNTHETIC_MAPPING_V1 } from '@dart/domain';
import { canonicalJson } from '@dart/forms';
import { Request } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, CurrentActor, Perm } from '../core/auth';
import { Db, Tx } from '../core/db';
import { ApiError, conflict, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';
import { sha256 } from './consent';

/** RFC-4180-ähnlicher CSV-Parser (Trennzeichen ; oder , automatisch). Werte bleiben Strings (Rohwerte). */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
  return { header: nonEmpty[0] ?? [], rows: nonEmpty.slice(1) };
}

const BatchInput = z.object({
  mapping: z.enum(['SYNTH', 'V05']).default('SYNTH'),
  fileName: z.string().min(1).max(200),
  sheet: z.string().regex(/^[A-Z0-9_]{1,20}$/),
  sourceSystem: z.string().max(60),
  exportVersion: z.string().max(60),
  csv: z.string().min(1).max(20_000_000),
});

interface Analysis {
  fileSha256: string;
  rows: Array<{ sourceRow: number; cells: Record<string, string>; result: NormalizedRow }>;
  summary: ReturnType<typeof summarize>;
}

function summarize(results: NormalizedRow[], header: string[]) {
  const rec = reconcile(results.map((r) => r.outcome as RowOutcome));
  const issueCounts: Record<string, number> = {};
  const valueOutcomes: Record<string, number> = {};
  const comparability: Record<string, number> = {};
  const byCenter: Record<string, number> = {};
  const byTimepoint: Record<string, number> = {};
  let values = 0;
  for (const r of results) {
    for (const i of r.issues) issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;
    for (const v of r.values) {
      values++;
      valueOutcomes[v.outcome] = (valueOutcomes[v.outcome] ?? 0) + 1;
      comparability[v.comparability] = (comparability[v.comparability] ?? 0) + 1;
    }
    byCenter[r.centerCode ?? '(leer)'] = (byCenter[r.centerCode ?? '(leer)'] ?? 0) + 1;
    byTimepoint[r.timepoint ?? '(ungeklärt)'] = (byTimepoint[r.timepoint ?? '(ungeklärt)'] ?? 0) + 1;
  }
  const expectedValues = results.length * header.length;
  return {
    zeilen: rec,
    werte: { geliefert: expectedValues, erfasst: values, ausgeglichen: values === expectedValues, nachErgebnis: valueOutcomes, vergleichbarkeit: comparability },
    hinweise: issueCounts,
    nachZentrumscode: byCenter,
    nachZeitpunkt: byTimepoint,
  };
}

@ApiTags('Migration')
@Controller('api/v1')
@Perm('migration.run')
export class MigrationController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  private tx<T>(fn: (c: Tx) => Promise<T>) {
    return this.db.tx({ centerIds: [] }, fn, this.db.migration);
  }

  /** Mappingdefinition: synthetisch oder aus dem Variablenkatalog V05 (Vorschlag ohne Freigabe). */
  private async mappingDef(c: Tx, which: 'SYNTH' | 'V05'): Promise<MappingRuleVersion> {
    if (which === 'SYNTH') return SYNTHETIC_MAPPING_V1;
    const { rows } = await c.query(`SELECT details FROM legacy.catalog_entry WHERE catalog_code = 'KNIE-V05' ORDER BY sheet, source_row`);
    if (!rows.length) throw new ApiError(409, 'ZUSTAND_UNZULAESSIG', 'Variablenkatalog V05 ist nicht geladen.');
    return mappingFromCatalog(rows.map((r) => r.details as CatalogEntry));
  }

  private async mappingVersion(c: Tx, def: MappingRuleVersion): Promise<string> {
    const hash = sha256(canonicalJson(def));
    const r = await c.query(
      `INSERT INTO legacy.mapping_rule_version (code, version, status, definition, definition_sha256) VALUES ($1,$2,'vorschlag',$3,$4)
       ON CONFLICT (code, version) DO UPDATE SET code = EXCLUDED.code RETURNING id, definition_sha256`,
      [def.code, def.version, JSON.stringify(def), hash],
    );
    if (r.rows[0].definition_sha256 !== hash) throw conflict('VERSION_UNVERAENDERLICH', 'Mappingversion wurde verändert; bitte neue Version anlegen.');
    return r.rows[0].id;
  }

  private async analyze(c: Tx, b: z.infer<typeof BatchInput>, mapping: MappingRuleVersion): Promise<Analysis> {
    const { header, rows } = parseCsv(b.csv);
    if (!header.length) throw new ApiError(400, 'VALIDIERUNG', 'Die Datei enthält keine Kopfzeile.');
    const dup = header.find((h, i) => header.indexOf(h) !== i);
    if (dup) throw new ApiError(400, 'VALIDIERUNG', `Doppelte Spalte „${dup}“ in der Kopfzeile.`);
    const centers = (await c.query('SELECT id, code FROM center')).rows;
    // Bestätigte Zentrumszuordnung (synthetisch: Alt-Code = Zentrumscode ohne Präfix); 999 wird nie zugeordnet
    const centerMap: Record<string, string> = {};
    for (const ce of centers) {
      const m = /^Z-?(\d+)$/.exec(ce.code);
      if (m && m[1] !== '999') centerMap[m[1]] = ce.id;
    }
    const ctx: MigrationContext = { sourceSystem: b.sourceSystem, exportVersion: b.exportVersion, mapping, centerMap };
    const out: Analysis['rows'] = [];
    rows.forEach((cells, i) => {
      const obj: Record<string, string> = {};
      header.forEach((h, j) => (obj[h] = cells[j] ?? ''));
      out.push({ sourceRow: i + 2, cells: obj, result: normalizeLegacyRow({ sheet: b.sheet, sourceRow: i + 2, cells: obj }, ctx) });
    });
    return { fileSha256: sha256(b.csv), rows: out, summary: summarize(out.map((r) => r.result), header) };
  }

  @Get('migration/manifest')
  manifest() {
    return this.tx(async (c) => ({ items: (await c.query('SELECT * FROM legacy.source_manifest ORDER BY source_code, file_name')).rows }));
  }

  @Get('migration/mapping')
  mapping() {
    return {
      verfuegbar: [
        { code: 'SYNTH', mapping: SYNTHETIC_MAPPING_V1.code, sourceSystem: SYNTHETIC_MAPPING_V1.sourceSystem, exportVersions: SYNTHETIC_MAPPING_V1.exportVersions, hinweis: 'Synthetische Demonstration' },
        { code: 'V05', mapping: 'MAP-DART-KNIE-V05', sourceSystem: 'DART-KNIE-PROD', exportVersions: ['V05'], hinweis: 'Aus Variablenkatalog V05, Status Vorschlag: ohne Freigabe wird nichts normalisiert' },
      ],
    };
  }

  /** Variablenkatalog V05 (Q02/Q03): Zusammenfassung. */
  @Get('migration/catalog/summary')
  catalogSummary() {
    return this.tx(async (c) => {
      const q = async (sql: string) => (await c.query(sql)).rows;
      const base = `FROM legacy.catalog_entry WHERE catalog_code = 'KNIE-V05'`;
      const [tot] = await q(`SELECT count(*)::int AS eintraege, count(*) FILTER (WHERE freigabe_durch IS NOT NULL)::int AS freigegeben, min(source_sha256) AS sha ${base}`);
      return {
        ...tot,
        nachKlasse: await q(`SELECT klasse, count(*)::int AS n ${base} GROUP BY klasse ORDER BY klasse`),
        nachBlatt: await q(`SELECT sheet, count(*)::int AS n, count(*) FILTER (WHERE klasse_code = 'A')::int AS a, count(*) FILTER (WHERE klasse_code = 'B')::int AS b, count(*) FILTER (WHERE klasse_code = 'C')::int AS c ${base} GROUP BY sheet ORDER BY n DESC`),
        hinweise: await q(`SELECT h AS hinweis, count(*)::int AS n FROM legacy.catalog_entry, unnest(pruefhinweise) h WHERE catalog_code = 'KNIE-V05' GROUP BY h ORDER BY n DESC`),
        basicScience: await q(`SELECT basic_science, count(*)::int AS n ${base} GROUP BY basic_science ORDER BY n DESC`),
        entscheidungen: await q(`SELECT entscheidung, count(*)::int AS n ${base} GROUP BY entscheidung`),
        neuanlage: await q(`SELECT position, zielstruktur, details FROM legacy.catalog_neuanlage WHERE catalog_code = 'KNIE-V05' ORDER BY position`),
      };
    });
  }

  /** Variablenkatalog durchsuchen (Blatt, Klasse, Prüfhinweis, Freitext). */
  @Get('migration/catalog')
  catalog(@Query() query: Record<string, string>) {
    const p = parse(
      z.object({ sheet: z.string().max(10).optional(), klasse: z.enum(['A', 'B', 'C']).optional(), hinweis: z.string().max(100).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1) }),
      query,
    );
    return this.tx(async (c) => {
      const where = [`catalog_code = 'KNIE-V05'`];
      const args: unknown[] = [];
      const add = (sql: (n: number) => string, v: unknown) => {
        args.push(v);
        where.push(sql(args.length));
      };
      if (p.sheet) add((n) => `sheet = $${n}`, p.sheet);
      if (p.klasse) add((n) => `klasse_code = $${n}`, p.klasse);
      if (p.hinweis) add((n) => `$${n} = ANY(pruefhinweise)`, p.hinweis);
      if (p.q) add((n) => `(alt_name ILIKE $${n} OR label ILIKE $${n} OR var_id ILIKE $${n} OR sas_alias ILIKE $${n})`, `%${p.q.replace(/[%_]/g, '')}%`);
      const total = (await c.query(`SELECT count(*)::int AS n FROM legacy.catalog_entry WHERE ${where.join(' AND ')}`, args)).rows[0].n;
      const { rows } = await c.query(
        `SELECT sheet, source_row, alt_name, sas_alias, var_id, klasse, label, basic_science, vergleichbarkeit, pruefhinweise, entscheidung, freigabe_durch,
                details->>'codeliste' AS codeliste, details->>'migrationsregel' AS migrationsregel
           FROM legacy.catalog_entry WHERE ${where.join(' AND ')} ORDER BY sheet, source_row LIMIT 50 OFFSET ${(p.page - 1) * 50}`,
        args,
      );
      return { total, page: p.page, pageSize: 50, items: rows };
    });
  }

  /** Probelauf: keine Zieldaten, nur Bericht (inkl. Bilanz) und protokollierter Batch. */
  @Post('migration-batches/dry-run')
  dryRun(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(BatchInput, body);
    return this.tx(async (c) => {
      const def = await this.mappingDef(c, b.mapping);
      const mappingId = await this.mappingVersion(c, def);
      const a = await this.analyze(c, b, def);
      const batch = await c.query(
        `INSERT INTO legacy.migration_batch (source_system, export_version, mapping_version_id, file_name, file_sha256, mode, status, summary, created_by)
         VALUES ($1,$2,$3,$4,$5,'probelauf','probelauf',$6,$7) RETURNING id`,
        [b.sourceSystem, b.exportVersion, mappingId, b.fileName, a.fileSha256, JSON.stringify(a.summary), actor.userId],
      );
      for (const r of a.rows) for (const i of r.result.issues) {
        await c.query('INSERT INTO legacy.reconciliation_issue (batch_id, source_row, code, message, column_name, blocking) VALUES ($1,$2,$3,$4,$5,$6)', [batch.rows[0].id, r.sourceRow, i.code, i.message, i.column ?? null, i.blocking]);
      }
      await this.audit.write(c, actor, { action: 'migration_probelauf', objectType: 'migration', objectId: batch.rows[0].id, requestId: requestIdOf(req) });
      return { batchId: batch.rows[0].id, mode: 'probelauf', fileSha256: a.fileSha256, summary: a.summary, beispiele: a.rows.slice(0, 20).map((r) => ({ zeile: r.sourceRow, ergebnis: r.result.outcome, hinweise: r.result.issues.map((i) => i.code) })) };
    });
  }

  /**
   * Import: idempotent (eindeutiger Quellschlüssel), Rohwerte unverändert, Quarantäne isoliert,
   * keine Einladungen/Kontoaktivierungen (Migration ist stumm).
   */
  @Post('migration-batches/import')
  import(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(BatchInput, body);
    return this.tx(async (c) => {
      const def = await this.mappingDef(c, b.mapping);
      const mappingId = await this.mappingVersion(c, def);
      const a = await this.analyze(c, b, def);
      const batch = await c.query(
        `INSERT INTO legacy.migration_batch (source_system, export_version, mapping_version_id, file_name, file_sha256, mode, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'import','importiert',$6) RETURNING id`,
        [b.sourceSystem, b.exportVersion, mappingId, b.fileName, a.fileSha256, actor.userId],
      );
      const batchId = batch.rows[0].id as string;
      let inserted = 0;
      let skipped = 0;
      for (const r of a.rows) {
        const raw = canonicalJson(r.cells);
        const ins = await c.query(
          `INSERT INTO legacy.legacy_record (batch_id, source_system, export_version, sheet, source_row, record_id, raw, raw_sha256, outcome, center_id, timepoint, op_date, side, procedures)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (source_system, export_version, sheet, source_row) DO NOTHING RETURNING id`,
          [batchId, b.sourceSystem, b.exportVersion, b.sheet, r.sourceRow, r.result.recordId, raw, sha256(raw), r.result.outcome, r.result.centerId, r.result.timepoint, r.result.opDate, r.result.side, JSON.stringify(r.result.procedures)],
        );
        if (!ins.rows.length) {
          skipped++;
          continue;
        }
        inserted++;
        const recId = ins.rows[0].id;
        for (const v of r.result.values) {
          await c.query(
            `INSERT INTO legacy.legacy_value (legacy_record_id, column_name, source_key, var_id, concept, raw_value, normalized, comparability, outcome, mapping_version_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [recId, v.column, v.sourceKey, v.varId, v.concept, v.raw, v.normalized === null ? null : JSON.stringify(v.normalized), v.comparability, v.outcome, mappingId],
          );
        }
        for (const i of r.result.issues) {
          await c.query('INSERT INTO legacy.reconciliation_issue (batch_id, legacy_record_id, source_row, code, message, column_name, blocking) VALUES ($1,$2,$3,$4,$5,$6,$7)', [batchId, recId, r.sourceRow, i.code, i.message, i.column ?? null, i.blocking]);
        }
      }
      const summary = { ...a.summary, import: { neu: inserted, bereitsVorhanden: skipped } };
      await c.query('UPDATE legacy.migration_batch SET summary = $2 WHERE id = $1', [batchId, JSON.stringify(summary)]);
      await this.audit.write(c, actor, { action: 'migration_import', objectType: 'migration', objectId: batchId, requestId: requestIdOf(req) });
      return { batchId, mode: 'import', fileSha256: a.fileSha256, summary };
    });
  }

  @Post('migration-batches/:id/rollback')
  rollback(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const bt = (await c.query('SELECT status, mode FROM legacy.migration_batch WHERE id = $1', [id])).rows[0];
      if (!bt) throw notFound();
      if (bt.mode !== 'import' || bt.status !== 'importiert') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur importierte Batches können zurückgerollt werden.');
      const del = await c.query('DELETE FROM legacy.legacy_record WHERE batch_id = $1', [id]);
      await c.query(`UPDATE legacy.migration_batch SET status = 'zurueckgerollt', rolled_back_at = now(), rolled_back_by = $2 WHERE id = $1`, [id, actor.userId]);
      await this.audit.write(c, actor, { action: 'migration_rollback', objectType: 'migration', objectId: id, requestId: requestIdOf(req) });
      return { batchId: id, status: 'zurueckgerollt', entfernteDatensaetze: del.rowCount };
    });
  }

  @Get('migration-batches')
  batches() {
    return this.tx(async (c) => ({
      items: (await c.query(
        `SELECT b.id, b.source_system, b.export_version, b.file_name, b.file_sha256, b.mode, b.status, b.summary, b.created_at, b.rolled_back_at, m.code AS mapping_code, m.version AS mapping_version,
                (SELECT count(*)::int FROM legacy.legacy_record r WHERE r.batch_id = b.id) AS records
           FROM legacy.migration_batch b JOIN legacy.mapping_rule_version m ON m.id = b.mapping_version_id ORDER BY b.created_at DESC`,
      )).rows,
    }));
  }

  /** Reconciliation-Bericht: Bilanz, Hinweise, Rohwert-Nachweis (Hashprüfung) je Batch. */
  @Get('migration-batches/:id/report')
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx(async (c) => {
      const b = (await c.query('SELECT * FROM legacy.migration_batch WHERE id = $1', [id])).rows[0];
      if (!b) throw notFound();
      const issues = (await c.query('SELECT code, blocking, count(*)::int AS n, min(message) AS beispiel FROM legacy.reconciliation_issue WHERE batch_id = $1 GROUP BY code, blocking ORDER BY n DESC', [id])).rows;
      const outcomes = (await c.query('SELECT outcome, count(*)::int AS n FROM legacy.legacy_record WHERE batch_id = $1 GROUP BY outcome', [id])).rows;
      const rawCheck = (await c.query('SELECT raw, raw_sha256 FROM legacy.legacy_record WHERE batch_id = $1', [id])).rows;
      const rawOk = rawCheck.filter((r) => sha256(canonicalJson(r.raw)) === r.raw_sha256).length;
      const orphans = (await c.query('SELECT count(*)::int AS n FROM legacy.legacy_value v LEFT JOIN legacy.legacy_record r ON r.id = v.legacy_record_id WHERE r.id IS NULL')).rows[0].n;
      const valueStats = (await c.query(
        `SELECT v.column_name, count(*)::int AS n, count(*) FILTER (WHERE v.raw_value = '')::int AS leer, count(*) FILTER (WHERE v.outcome = 'normalisiert')::int AS normalisiert,
                count(*) FILTER (WHERE v.outcome = 'ungeklaert')::int AS ungeklaert, min(v.raw_value) FILTER (WHERE v.raw_value <> '') AS min_roh, max(v.raw_value) FILTER (WHERE v.raw_value <> '') AS max_roh
           FROM legacy.legacy_value v JOIN legacy.legacy_record r ON r.id = v.legacy_record_id WHERE r.batch_id = $1 GROUP BY v.column_name ORDER BY v.column_name`,
        [id],
      )).rows;
      return {
        batch: b,
        bilanz: b.summary?.zeilen ?? null,
        importierteZeilenNachErgebnis: outcomes,
        hinweise: issues,
        rohwertNachweis: { geprueft: rawCheck.length, hashKorrekt: rawOk, vollstaendig: rawOk === rawCheck.length },
        verwaisteWerte: orphans,
        variablenStatistik: valueStats,
      };
    });
  }

  @Get('migration-batches/:id/issues')
  issues(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx(async (c) => ({ items: (await c.query('SELECT source_row, code, message, column_name, blocking, status FROM legacy.reconciliation_issue WHERE batch_id = $1 ORDER BY source_row, code LIMIT 1000', [id])).rows }));
  }
}
