import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MigrationContext, normalizeLegacyRow, NormalizedRow, reconcile, RowOutcome, SYNTHETIC_MAPPING_V1 } from '@dart/domain';
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

  private async mappingVersion(c: Tx): Promise<string> {
    const def = SYNTHETIC_MAPPING_V1;
    const hash = sha256(canonicalJson(def));
    const r = await c.query(
      `INSERT INTO legacy.mapping_rule_version (code, version, status, definition, definition_sha256) VALUES ($1,$2,'vorschlag',$3,$4)
       ON CONFLICT (code, version) DO UPDATE SET code = EXCLUDED.code RETURNING id, definition_sha256`,
      [def.code, def.version, JSON.stringify(def), hash],
    );
    if (r.rows[0].definition_sha256 !== hash) throw conflict('VERSION_UNVERAENDERLICH', 'Mappingversion wurde verändert; bitte neue Version anlegen.');
    return r.rows[0].id;
  }

  private async analyze(c: Tx, b: z.infer<typeof BatchInput>): Promise<Analysis> {
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
    const ctx: MigrationContext = { sourceSystem: b.sourceSystem, exportVersion: b.exportVersion, mapping: SYNTHETIC_MAPPING_V1, centerMap };
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
    return { mapping: SYNTHETIC_MAPPING_V1, hinweis: 'Synthetische Mappingversion (Vorschlag). Keine bestätigten Mappingregeln.' };
  }

  /** Probelauf: keine Zieldaten, nur Bericht (inkl. Bilanz) und protokollierter Batch. */
  @Post('migration-batches/dry-run')
  dryRun(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(BatchInput, body);
    return this.tx(async (c) => {
      const mappingId = await this.mappingVersion(c);
      const a = await this.analyze(c, b);
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
      const mappingId = await this.mappingVersion(c);
      const a = await this.analyze(c, b);
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
