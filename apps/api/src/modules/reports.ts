import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExportRequestSchema } from '@dart/contracts';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm } from '../core/auth';
import { todayBerlin } from '../core/config';
import { Db } from '../core/db';
import { ApiError, conflict, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';

@ApiTags('Auswertung')
@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  /**
   * Zentrumsbericht (F18). Nenner werden explizit ausgewiesen; registerübergreifende Fälle
   * werden in der Gesamtzahl einmal gezählt. Kein Wirksamkeitsnachweis.
   */
  @Get('center')
  @Perm('report.read')
  async center(@CurrentActor() actor: Actor, @Query() query: Record<string, string>, @Req() req: Request) {
    const q = parse(z.object({ centerId: z.string().uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), query);
    const centers = centersWith(actor, 'report.read');
    if (q.centerId && !centers.includes(q.centerId)) throw notFound();
    const scope = q.centerId ? [q.centerId] : centers;
    const today = todayBerlin();
    return this.db.tx({ centerIds: scope }, async (c) => {
      const filt = `($1::date IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= $1) AND ($2::date IS NULL OR COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= $2)`;
      const args = [q.from ?? null, q.to ?? null];
      const totals = (await c.query(`SELECT count(*)::int AS cases, count(DISTINCT patient_id)::int AS patients FROM treatment_case tc WHERE ${filt}`, args)).rows[0];
      const byStatus = (await c.query(`SELECT status, count(*)::int AS n FROM treatment_case tc WHERE ${filt} GROUP BY status ORDER BY status`, args)).rows;
      const byMode = (await c.query(`SELECT m.mode, count(*)::int AS n FROM treatment_case tc JOIN capture_mode_history m ON m.case_id = tc.id AND m.valid_to IS NULL WHERE ${filt} GROUP BY m.mode`, args)).rows;
      const byRegister = (await c.query(`SELECT r.register_code, count(DISTINCT tc.id)::int AS n FROM treatment_case tc JOIN case_register_membership r ON r.case_id = tc.id AND r.valid_to IS NULL WHERE ${filt} GROUP BY r.register_code ORDER BY r.register_code`, args)).rows;
      const multiRegister = (await c.query(`SELECT count(*)::int AS n FROM (SELECT tc.id FROM treatment_case tc JOIN case_register_membership r ON r.case_id = tc.id AND r.valid_to IS NULL WHERE ${filt} GROUP BY tc.id HAVING count(*) > 1) x`, args)).rows[0].n;
      const physician = (await c.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.status = 'abgeschlossen')::int AS done
           FROM response r JOIN treatment_case tc ON tc.id = r.case_id WHERE r.audience = 'arzt' AND ${filt}`,
        args,
      )).rows[0];
      const followUp = (await c.query(
        `SELECT e.timepoint,
                count(*) FILTER (WHERE e.window_start <= $3 AND e.status <> 'gesperrt')::int AS faellig,
                count(*) FILTER (WHERE e.window_start <= $3 AND e.status = 'abgeschlossen')::int AS abgeschlossen,
                count(*) FILTER (WHERE e.status = 'gesperrt')::int AS gesperrt,
                count(*) FILTER (WHERE e.window_start > $3)::int AS noch_nicht_faellig
           FROM assessment_event e JOIN treatment_case tc ON tc.id = e.case_id WHERE ${filt} AND e.source = 'plan'
          GROUP BY e.timepoint`,
        [...args, today],
      )).rows;
      const order = ['BL', 'M6', 'M12', 'M24', 'M36', 'M60', 'M120'];
      followUp.sort((a, b) => order.indexOf(a.timepoint) - order.indexOf(b.timepoint));
      await this.audit.write(c, actor, { action: 'bericht_zentrum', objectType: 'bericht', objectId: q.centerId ?? 'alle', requestId: requestIdOf(req) });
      return {
        stichtag: today,
        filter: { zentren: scope.length, von: q.from ?? null, bis: q.to ?? null, bezug: 'Bezugsdatum (tatsächliches/geplantes OP-Datum bzw. konservativer Behandlungsbeginn)' },
        totals,
        byStatus,
        byMode,
        byRegister,
        multiRegisterCases: multiRegister,
        physicianCompleteness: { ...physician, nenner: 'Angelegte Arztbögen in aktiven Fällen' },
        followUp: followUp.map((f) => ({ ...f, ruecklauf: f.faellig > 0 ? Math.round((f.abgeschlossen / f.faellig) * 1000) / 10 : null })),
        hinweise: [
          'Rücklaufnenner: nur fällige (Fenster begonnen) und nicht gesperrte Erhebungen.',
          'Fälle mit mehreren Registern erscheinen in der Registeraufschlüsselung mehrfach, in der Gesamtzahl einmal.',
          'Qualitätskennzahlen sind kein Wirksamkeitsnachweis. Demonstrationswerte mit synthetischen Daten.',
        ],
      };
    });
  }
}

@ApiTags('Export')
@Controller('api/v1/exports')
export class ExportsController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  /** Antrag mit Zweck, Kohorte, Zeitraum und Scope (F19). */
  @Post()
  @Perm('export.request')
  async request(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(ExportRequestSchema, body);
    if (b.periodFrom > b.periodTo) throw new ApiError(400, 'VALIDIERUNG', 'Zeitraum ungültig.');
    return this.db.tx({ centerIds: [] }, async (c) => {
      if (b.centerIds?.length) {
        const n = (await c.query('SELECT count(*)::int AS n FROM center WHERE id = ANY($1::uuid[])', [b.centerIds])).rows[0].n;
        if (n !== b.centerIds.length) throw new ApiError(400, 'VALIDIERUNG', 'Unbekanntes Zentrum.');
      }
      const r = await c.query(
        `INSERT INTO export_job (requested_by, purpose, scope, center_ids, period_from, period_to, layers) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [actor.userId, b.purpose, b.scope, b.centerIds?.length ? b.centerIds : null, b.periodFrom, b.periodTo, b.layers],
      );
      await this.audit.write(c, actor, { action: 'export_beantragen', objectType: 'export', objectId: r.rows[0].id, reason: b.purpose.slice(0, 200), requestId: requestIdOf(req) });
      return { id: r.rows[0].id, status: 'beantragt' };
    });
  }

  @Get()
  async list(@CurrentActor() actor: Actor) {
    const approver = can(actor, 'export.approve');
    if (!approver && !can(actor, 'export.request')) throw new ApiError(403, 'KEINE_BERECHTIGUNG');
    const { rows } = await this.db.app.query(
      `SELECT j.id, j.purpose, j.scope, j.period_from, j.period_to, j.layers, j.status, j.created_at, j.decided_at, j.decision_note, j.stichtag, j.result_summary,
              rq.display_name AS requested_by_name, d.display_name AS decided_by_name, j.requested_by = $1 AS own,
              (SELECT json_agg(json_build_object('name', f.file_name, 'sha256', f.sha256, 'bytes', length(f.content)) ORDER BY f.file_name) FROM export_file f WHERE f.export_job_id = j.id) AS files
         FROM export_job j JOIN app_user rq ON rq.id = j.requested_by LEFT JOIN app_user d ON d.id = j.decided_by
        WHERE $2 OR j.requested_by = $1 ORDER BY j.created_at DESC`,
      [actor.userId, approver],
    );
    return { items: rows };
  }

  /** Genehmigung durch eine andere Person als die antragstellende. */
  @Post(':id/decide')
  @Perm('export.approve')
  decide(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ decision: z.enum(['genehmigt', 'abgelehnt']), note: z.string().min(5).max(1000) }), body);
    return this.db.tx({ centerIds: [] }, async (c) => {
      const j = (await c.query('SELECT status, requested_by FROM export_job WHERE id = $1', [id])).rows[0];
      if (!j) throw notFound();
      if (j.status !== 'beantragt') throw conflict('ZUSTAND_UNZULAESSIG');
      if (j.requested_by === actor.userId) throw new ApiError(403, 'VIER_AUGEN');
      await c.query('UPDATE export_job SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1', [id, b.decision, actor.userId, b.note]);
      await this.audit.write(c, actor, { action: `export_${b.decision}`, objectType: 'export', objectId: id, reason: b.note, requestId: requestIdOf(req) });
      return { id, status: b.decision };
    });
  }

  @Get(':id/files/:name')
  async file(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('name') name: string, @Req() req: Request, @Res() res: Response) {
    const f = await this.db.tx({ centerIds: [] }, async (c) => {
      const j = (await c.query('SELECT status, requested_by FROM export_job WHERE id = $1', [id])).rows[0];
      // Nur die antragstellende Person erhält den zweckgebundenen Export
      if (!j || j.requested_by !== actor.userId || j.status !== 'fertig') {
        await this.audit.write(c, actor, { action: 'export_download', objectType: 'export', objectId: id, result: 'abgelehnt', requestId: requestIdOf(req) });
        throw notFound();
      }
      const row = (await c.query('SELECT file_name, content_type, content, sha256 FROM export_file WHERE export_job_id = $1 AND file_name = $2', [id, name])).rows[0];
      if (!row) throw notFound();
      await this.audit.write(c, actor, { action: 'export_download', objectType: 'export', objectId: id, reason: name, requestId: requestIdOf(req) });
      return row;
    });
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${f.file_name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.setHeader('X-Checksum-SHA256', f.sha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.content);
  }
}
