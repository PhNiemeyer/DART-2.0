import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { canonicalJson, diffSchemas, FormItem, FormSchema, validateSchema } from '@dart/forms';
import { Request } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, CurrentActor, Perm } from '../core/auth';
import { todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { ApiError, conflict, invalid, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';
import { sha256 } from './consent';

/**
 * Formularredaktion (F08): Entwurf → Prüfung → Vier-Augen-Freigabe → Veröffentlichung → Ruhestand.
 * Veröffentlichte Versionen sind unveränderlich (zusätzlich per DB-Trigger erzwungen).
 */
const SchemaInput = z.object({ schema: z.any(), changeNote: z.string().max(2000).optional() });

function flatItems(schema: FormSchema): FormItem[] {
  const out: FormItem[] = [];
  for (const s of schema.sections) for (const i of s.items) {
    if (i.type === 'group') out.push(...(i.items ?? []));
    else out.push(i);
  }
  return out;
}

export function schemaHash(schema: unknown): string {
  return sha256(canonicalJson(schema));
}

@ApiTags('Formulare')
@Controller('api/v1')
export class FormsController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  private tx<T>(fn: (c: Tx) => Promise<T>) {
    return this.db.tx({ centerIds: [] }, fn);
  }

  @Get('questionnaires')
  @Perm('form.read')
  list() {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT q.id, q.code, q.title, q.audience, q.module_code,
                json_agg(json_build_object('id', v.id, 'version', v.version, 'status', v.status, 'published_at', v.published_at, 'valid_from', v.valid_from, 'valid_to', v.valid_to, 'schema_hash', v.schema_hash) ORDER BY v.version DESC) AS versions
           FROM questionnaire q LEFT JOIN questionnaire_version v ON v.questionnaire_id = q.id
          GROUP BY q.id ORDER BY q.audience, q.code`,
      );
      return { items: rows };
    });
  }

  @Post('questionnaires')
  @Perm('form.draft')
  create(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,40}$/), title: z.string().min(2).max(200), audience: z.enum(['arzt', 'patient']), module: z.string().max(40) }), body);
    return this.tx(async (c) => {
      const q = await c.query('INSERT INTO questionnaire (code, title, audience, module_code) VALUES ($1,$2,$3,$4) RETURNING id', [b.code, b.title, b.audience, b.module]);
      const schema: FormSchema = { schemaVersion: 1, code: b.code, title: b.title, audience: b.audience, module: b.module, sections: [{ id: 'abschnitt_1', title: 'Abschnitt 1', items: [] }] };
      const v = await c.query(`INSERT INTO questionnaire_version (questionnaire_id, version, schema, author_id, change_note) VALUES ($1, 1, $2, $3, 'Neuanlage') RETURNING id`, [q.rows[0].id, JSON.stringify(schema), actor.userId]);
      await this.audit.write(c, actor, { action: 'formular_anlegen', objectType: 'formular', objectId: q.rows[0].id, requestId: requestIdOf(req) });
      return { questionnaireId: q.rows[0].id, versionId: v.rows[0].id };
    });
  }

  @Get('form-versions/:id')
  @Perm('form.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT v.*, q.code, q.title, q.audience, q.module_code, a.display_name AS author_name, ap.display_name AS approver_name, pb.display_name AS publisher_name
           FROM questionnaire_version v JOIN questionnaire q ON q.id = v.questionnaire_id
           LEFT JOIN app_user a ON a.id = v.author_id LEFT JOIN app_user ap ON ap.id = v.approved_by LEFT JOIN app_user pb ON pb.id = v.published_by
          WHERE v.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound();
      return { ...rows[0], validation: validateSchema(rows[0].schema) };
    });
  }

  /** Neue Entwurfsversion auf Basis der neuesten Version. */
  @Post('questionnaires/:id/versions')
  @Perm('form.draft')
  newVersion(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const open = await c.query(`SELECT id FROM questionnaire_version WHERE questionnaire_id = $1 AND status IN ('entwurf','in_pruefung','freigegeben')`, [id]);
      if (open.rows.length) throw conflict('ZUSTAND_UNZULAESSIG', 'Es existiert bereits eine offene Version (Entwurf/Prüfung/Freigabe).');
      const last = await c.query('SELECT version, schema FROM questionnaire_version WHERE questionnaire_id = $1 ORDER BY version DESC LIMIT 1', [id]);
      if (!last.rows[0]) throw notFound();
      const v = await c.query(
        `INSERT INTO questionnaire_version (questionnaire_id, version, schema, author_id, change_note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id, last.rows[0].version + 1, JSON.stringify(last.rows[0].schema), actor.userId, `Neue Version auf Basis von V${last.rows[0].version}`],
      );
      await this.audit.write(c, actor, { action: 'formular_version_neu', objectType: 'formularversion', objectId: v.rows[0].id, requestId: requestIdOf(req) });
      return { versionId: v.rows[0].id, version: last.rows[0].version + 1 };
    });
  }

  @Put('form-versions/:id')
  @Perm('form.draft')
  update(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(SchemaInput, body);
    return this.tx(async (c) => {
      const v = (await c.query('SELECT v.status, q.code, q.audience, q.module_code FROM questionnaire_version v JOIN questionnaire q ON q.id = v.questionnaire_id WHERE v.id = $1', [id])).rows[0];
      if (!v) throw notFound();
      if (v.status !== 'entwurf') throw conflict('VERSION_UNVERAENDERLICH', 'Nur Entwürfe können bearbeitet werden.');
      const schema = b.schema as FormSchema;
      if (!schema || typeof schema !== 'object' || schema.code !== v.code || schema.audience !== v.audience) throw invalid('Formularcode und Zielgruppe müssen zum Formular passen.');
      if (JSON.stringify(schema).length > 500_000) throw invalid('Schema zu groß.');
      await c.query('UPDATE questionnaire_version SET schema = $2, change_note = COALESCE($3, change_note) WHERE id = $1', [id, JSON.stringify(schema), b.changeNote ?? null]);
      await this.audit.write(c, actor, { action: 'formular_entwurf_speichern', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, validation: validateSchema(schema) };
    });
  }

  @Post('form-versions/:id/submit-review')
  @Perm('form.draft')
  submitReview(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const v = (await c.query('SELECT status, schema FROM questionnaire_version WHERE id = $1', [id])).rows[0];
      if (!v) throw notFound();
      if (v.status !== 'entwurf') throw conflict('ZUSTAND_UNZULAESSIG');
      const errors = validateSchema(v.schema);
      if (errors.length) throw new ApiError(422, 'SCHEMA_UNGUELTIG', `Das Schema enthält ${errors.length} Fehler.`, errors);
      await c.query(`UPDATE questionnaire_version SET status = 'in_pruefung', submitted_at = now(), schema_hash = $2 WHERE id = $1`, [id, schemaHash(v.schema)]);
      await this.audit.write(c, actor, { action: 'formular_zur_pruefung', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, status: 'in_pruefung' };
    });
  }

  @Post('form-versions/:id/reject')
  @Perm('form.publish')
  reject(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: z.string().min(5).max(1000) }), body);
    return this.tx(async (c) => {
      const v = (await c.query('SELECT status FROM questionnaire_version WHERE id = $1', [id])).rows[0];
      if (!v) throw notFound();
      if (!['in_pruefung', 'freigegeben'].includes(v.status)) throw conflict('ZUSTAND_UNZULAESSIG');
      await c.query(`UPDATE questionnaire_version SET status = 'entwurf', approved_by = NULL, approved_at = NULL, schema_hash = NULL WHERE id = $1`, [id]);
      await this.audit.write(c, actor, { action: 'formular_zurueckgewiesen', objectType: 'formularversion', objectId: id, reason, requestId: requestIdOf(req) });
      return { id, status: 'entwurf' };
    });
  }

  /** Vier-Augen-Freigabe: Freigebende Person ≠ Autor. */
  @Post('form-versions/:id/approve')
  @Perm('form.publish')
  approve(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const v = (await c.query('SELECT status, author_id, schema, schema_hash FROM questionnaire_version WHERE id = $1', [id])).rows[0];
      if (!v) throw notFound();
      if (v.status !== 'in_pruefung') throw conflict('ZUSTAND_UNZULAESSIG');
      if (v.author_id === actor.userId) throw new ApiError(403, 'VIER_AUGEN');
      if (schemaHash(v.schema) !== v.schema_hash) throw conflict('KONFLIKT', 'Schema-Hash stimmt nicht mit der geprüften Fassung überein.');
      await c.query(`UPDATE questionnaire_version SET status = 'freigegeben', approved_by = $2, approved_at = now() WHERE id = $1`, [id, actor.userId]);
      await this.audit.write(c, actor, { action: 'formular_freigeben', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, status: 'freigegeben' };
    });
  }

  @Post('form-versions/:id/publish')
  @Perm('form.publish')
  publish(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const v = (await c.query('SELECT * FROM questionnaire_version WHERE id = $1', [id])).rows[0];
      if (!v) throw notFound();
      if (v.status !== 'freigegeben') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur freigegebene Versionen können veröffentlicht werden.');
      if (v.author_id === actor.userId) throw new ApiError(403, 'VIER_AUGEN');
      const today = todayBerlin();
      await c.query(`UPDATE questionnaire_version SET status = 'ruhestand', valid_to = $2 WHERE questionnaire_id = $1 AND status = 'veroeffentlicht'`, [v.questionnaire_id, today]);
      await c.query(`UPDATE questionnaire_version SET status = 'veroeffentlicht', published_by = $2, published_at = now(), valid_from = $3 WHERE id = $1`, [id, actor.userId, today]);
      for (const item of flatItems(v.schema)) {
        const concept = await c.query(
          `INSERT INTO variable_concept (var_id, label) VALUES ($1,$2) ON CONFLICT (var_id) DO UPDATE SET label = variable_concept.label RETURNING id`,
          [item.varId, item.label],
        );
        await c.query(
          `INSERT INTO variable_definition_version (concept_id, questionnaire_version_id, item_id, item_type, label, unit, codes) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [concept.rows[0].id, id, item.id, item.type, item.label, item.unit ?? null, item.codes ? JSON.stringify(item.codes) : null],
        );
      }
      await this.audit.write(c, actor, { action: 'formular_veroeffentlichen', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, status: 'veroeffentlicht', validFrom: today, hash: v.schema_hash };
    });
  }

  @Post('form-versions/:id/retire')
  @Perm('form.publish')
  retire(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const r = await c.query(`UPDATE questionnaire_version SET status = 'ruhestand', valid_to = $2 WHERE id = $1 AND status = 'veroeffentlicht' RETURNING id`, [id, todayBerlin()]);
      if (!r.rows.length) throw conflict('ZUSTAND_UNZULAESSIG');
      await this.audit.write(c, actor, { action: 'formular_ruhestand', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, status: 'ruhestand' };
    });
  }

  @Post('form-versions/:id/discard')
  @Perm('form.draft')
  discard(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tx(async (c) => {
      const r = await c.query(`DELETE FROM questionnaire_version WHERE id = $1 AND status = 'entwurf' AND version > 1 RETURNING id`, [id]);
      if (!r.rows.length) throw conflict('ZUSTAND_UNZULAESSIG', 'Nur Entwürfe ab Version 2 können verworfen werden.');
      await this.audit.write(c, actor, { action: 'formular_entwurf_verwerfen', objectType: 'formularversion', objectId: id, requestId: requestIdOf(req) });
      return { id, deleted: true };
    });
  }

  /**
   * Versionsvergleich (R-10): diese Version gegenüber einer anderen Version desselben Formulars
   * (Standard: unmittelbare Vorgängerversion). Vergleich über stabile Item-IDs, kritische Änderungen markiert.
   */
  @Get('form-versions/:id/diff')
  @Perm('form.read')
  diff(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, string>) {
    const q = parse(z.object({ gegen: z.string().uuid().optional() }), query);
    return this.tx(async (c) => {
      const v = (await c.query('SELECT id, questionnaire_id, version, status, schema FROM questionnaire_version WHERE id = $1', [id])).rows[0];
      if (!v) throw notFound();
      const versionen = (await c.query('SELECT id, version, status FROM questionnaire_version WHERE questionnaire_id = $1 ORDER BY version DESC', [v.questionnaire_id])).rows;
      const base = q.gegen
        ? (await c.query('SELECT id, questionnaire_id, version, status, schema FROM questionnaire_version WHERE id = $1', [q.gegen])).rows[0]
        : (await c.query('SELECT id, questionnaire_id, version, status, schema FROM questionnaire_version WHERE questionnaire_id = $1 AND version < $2 ORDER BY version DESC LIMIT 1', [v.questionnaire_id, v.version])).rows[0];
      if (q.gegen && (!base || base.questionnaire_id !== v.questionnaire_id)) throw invalid('Verglichen werden nur Versionen desselben Formulars.');
      const meta = (x: { id: string; version: number; status: string }) => ({ id: x.id, version: x.version, status: x.status });
      return { ziel: meta(v), basis: base ? meta(base) : null, versionen, diff: base ? diffSchemas(base.schema, v.schema) : null };
    });
  }

  /** Export als versioniertes JSON mit Hash, Autor, Freigabe und Gültigkeit. */
  @Get('form-versions/:id/export')
  @Perm('form.read')
  export(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx(async (c) => {
      const v = (await c.query(
        `SELECT v.*, q.code, a.username AS author, ap.username AS approver FROM questionnaire_version v JOIN questionnaire q ON q.id = v.questionnaire_id
           LEFT JOIN app_user a ON a.id = v.author_id LEFT JOIN app_user ap ON ap.id = v.approved_by WHERE v.id = $1`,
        [id],
      )).rows[0];
      if (!v) throw notFound();
      return {
        format: 'DART-Formular-Export',
        formatVersion: 1,
        code: v.code,
        version: v.version,
        status: v.status,
        schemaSha256: schemaHash(v.schema),
        storedHash: v.schema_hash,
        author: v.author,
        approvedBy: v.approver,
        validFrom: v.valid_from,
        validTo: v.valid_to,
        schema: v.schema,
      };
    });
  }

  /** Import: legt immer einen neuen Entwurf an (nie eine direkte Veröffentlichung). */
  @Post('questionnaires/import')
  @Perm('form.draft')
  import(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ format: z.literal('DART-Formular-Export'), schema: z.any(), schemaSha256: z.string() }), body);
    if (schemaHash(b.schema) !== b.schemaSha256) throw invalid('Prüfsumme des importierten Schemas stimmt nicht.');
    const schema = b.schema as FormSchema;
    const errors = validateSchema(schema);
    return this.tx(async (c) => {
      let q = (await c.query('SELECT id FROM questionnaire WHERE code = $1', [schema.code])).rows[0];
      if (!q) q = (await c.query('INSERT INTO questionnaire (code, title, audience, module_code) VALUES ($1,$2,$3,$4) RETURNING id', [schema.code, schema.title, schema.audience, schema.module])).rows[0];
      const open = await c.query(`SELECT id FROM questionnaire_version WHERE questionnaire_id = $1 AND status IN ('entwurf','in_pruefung','freigegeben')`, [q.id]);
      if (open.rows.length) throw conflict('ZUSTAND_UNZULAESSIG', 'Es existiert bereits eine offene Version.');
      const last = (await c.query('SELECT COALESCE(max(version),0) AS v FROM questionnaire_version WHERE questionnaire_id = $1', [q.id])).rows[0].v;
      const v = await c.query(`INSERT INTO questionnaire_version (questionnaire_id, version, schema, author_id, change_note) VALUES ($1,$2,$3,$4,'Import') RETURNING id`, [q.id, last + 1, JSON.stringify(schema), actor.userId]);
      await this.audit.write(c, actor, { action: 'formular_import', objectType: 'formularversion', objectId: v.rows[0].id, requestId: requestIdOf(req) });
      return { versionId: v.rows[0].id, version: last + 1, validation: errors };
    });
  }
}
