import { Body, Controller, Get, Headers, Injectable, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PatchDraftSchema, ReasonSchema } from '@dart/contracts';
import { AnswerMap, AnswerValue, blockingIssues, evaluateForm, FormSchema, indexItems, isValidIsoDate, parseAnswerKey } from '@dart/forms';
import { Request, Response } from 'express';
import { Audit, AuditActor } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm, readableCenters } from '../core/auth';
import { Db, DbScope, Tx } from '../core/db';
import { ApiError, conflict, invalid, notFound, requestIdOf } from '../core/errors';
import { Idempotency, parse } from '../core/http';
import { consentGate, loadCase } from './followup.service';

export type Who = { kind: 'nutzer'; actor: Actor } | { kind: 'patient'; patientId: string; centerId: string };

interface ResponseRow {
  id: string;
  center_id: string;
  case_id: string;
  assessment_event_id: string;
  questionnaire_version_id: string;
  module_code: string;
  audience: 'arzt' | 'patient';
  status: 'entwurf' | 'abgeschlossen' | 'wiedereroeffnet';
  instances: Record<string, string[]>;
  revision: number;
  submitted_at: string | null;
  updated_at: string;
  schema: FormSchema;
  schema_hash: string;
  version: number;
  questionnaire_code: string;
  timepoint: string;
}

function auditActor(w: Who): AuditActor {
  return w.kind === 'nutzer' ? w.actor : { kind: 'patient', patientId: w.patientId };
}

export function scopeFor(w: Who, perm: 'case.read' | 'case.write' = 'case.read'): DbScope {
  return w.kind === 'nutzer' ? { centerIds: perm === 'case.read' ? readableCenters(w.actor) : centersWith(w.actor, perm) } : { centerIds: [w.centerId], patientId: w.patientId };
}

function rowToAnswer(r: { value_text: string | null; value_number: number | null; value_date: string | null; value_codes: string[] | null; missing_reason: string | null }): AnswerValue {
  if (r.missing_reason) return { missing: r.missing_reason as AnswerValue['missing'] };
  if (r.value_codes) return { value: r.value_codes };
  if (r.value_number !== null) return { value: Number(r.value_number) };
  if (r.value_date) return { value: r.value_date };
  return { value: r.value_text };
}

@Injectable()
export class ResponsesService {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly idem: Idempotency) {}

  async load(c: Tx, id: string, w: Who): Promise<ResponseRow> {
    const { rows } = await c.query(
      `SELECT r.*, qv.schema, qv.schema_hash, qv.version, q.code AS questionnaire_code, e.timepoint
         FROM response r JOIN questionnaire_version qv ON qv.id = r.questionnaire_version_id
         JOIN questionnaire q ON q.id = qv.questionnaire_id JOIN assessment_event e ON e.id = r.assessment_event_id
        WHERE r.id = $1`,
      [id],
    );
    const r = rows[0] as ResponseRow | undefined;
    if (!r) throw notFound();
    if (w.kind === 'nutzer' && !can(w.actor, 'case.read', r.center_id)) throw notFound();
    if (w.kind === 'patient') {
      if (r.audience !== 'patient') throw notFound();
      const own = await c.query('SELECT patient_id FROM treatment_case WHERE id = $1', [r.case_id]);
      if (own.rows[0]?.patient_id !== w.patientId) throw notFound();
    }
    return r;
  }

  async answers(c: Tx, id: string): Promise<{ answers: AnswerMap; inactive: string[] }> {
    const { rows } = await c.query('SELECT * FROM answer WHERE response_id = $1', [id]);
    const answers: AnswerMap = {};
    const inactive: string[] = [];
    for (const r of rows) {
      answers[r.answer_key] = rowToAnswer(r);
      if (!r.active) inactive.push(r.answer_key);
    }
    return { answers, inactive };
  }

  private async gate(c: Tx, r: ResponseRow) {
    const cs = await loadCase(c, r.case_id);
    if (!cs) throw notFound();
    const g = await consentGate(c, cs);
    if (!g.ok) throw new ApiError(403, 'CONSENT_FEHLT', `Die Erfassung ist gesperrt: ${g.reason}.`);
    const ev = await c.query('SELECT status FROM assessment_event WHERE id = $1', [r.assessment_event_id]);
    if (ev.rows[0]?.status === 'gesperrt') throw new ApiError(403, 'CONSENT_FEHLT', 'Die Erhebung ist gesperrt.');
  }

  private checkWrite(w: Who, r: ResponseRow, perm: 'case.write' | 'case.finalize') {
    if (w.kind === 'patient') {
      if (r.audience !== 'patient') throw notFound();
      return;
    }
    if (r.audience !== 'arzt') throw new ApiError(403, 'KEINE_BERECHTIGUNG', 'Patientenbögen werden ausschließlich von Patientinnen und Patienten ausgefüllt.');
    if (!can(w.actor, perm, r.center_id)) throw new ApiError(403, 'KEINE_BERECHTIGUNG');
  }

  async get(id: string, w: Who, req: Request) {
    return this.db.tx(scopeFor(w), async (c) => {
      const r = await this.load(c, id, w);
      if (w.kind === 'patient') await this.gate(c, r);
      const { answers, inactive } = await this.answers(c, id);
      const evaluation = evaluateForm(r.schema, { answers, instances: r.instances });
      const lastRev = await c.query('SELECT changed_by, changed_by_patient, created_at FROM response_revision WHERE response_id = $1 ORDER BY revision DESC LIMIT 1', [id]);
      await this.audit.write(c, auditActor(w), { action: 'bogen_lesen', objectType: 'antwort', objectId: id, centerId: r.center_id, requestId: requestIdOf(req) });
      return {
        id: r.id,
        caseId: r.case_id,
        status: r.status,
        audience: r.audience,
        module: r.module_code,
        timepoint: r.timepoint,
        revision: r.revision,
        questionnaire: { code: r.questionnaire_code, version: r.version, hash: r.schema_hash },
        schema: r.schema,
        answers,
        instances: r.instances,
        storedInactiveKeys: inactive,
        evaluation,
        lastChange: lastRev.rows[0] ?? null,
        request_id: requestIdOf(req),
      };
    });
  }

  /** Autosave mit Optimistic Locking (If-Match: Revision). Ausgeblendete Antworten bleiben erhalten (inaktiv). */
  async saveDraft(id: string, ifMatch: string | undefined, body: unknown, w: Who, req: Request) {
    const expected = parseRevision(ifMatch);
    const b = parse(PatchDraftSchema, body);
    return this.db.tx(scopeFor(w, 'case.write'), async (c) => {
      const r = await this.load(c, id, w);
      this.checkWrite(w, r, 'case.write');
      await this.gate(c, r);
      if (r.status === 'abgeschlossen') throw conflict('ZUSTAND_UNZULAESSIG', 'Der Bogen ist abgeschlossen. Bitte zuerst mit Begründung wieder öffnen.');
      if (r.revision !== expected) throw await this.conflictError(c, r);
      const idx = indexItems(r.schema);
      const current = await this.answers(c, id);
      const merged: AnswerMap = { ...current.answers };
      const instances = b.instances ?? r.instances;
      for (const [gid, list] of Object.entries(instances)) {
        const g = idx.get(gid);
        if (!g || g.item.type !== 'group') throw invalid(`Unbekannte Gruppe ${gid}`);
        for (const iid of list) if (!/^[a-z0-9-]{1,64}$/.test(iid)) throw invalid('Ungültige Instanzkennung');
      }
      for (const [key, val] of Object.entries(b.answers)) {
        const { itemId, groupId, instanceId } = parseAnswerKey(key);
        const entry = idx.get(itemId);
        if (!entry || entry.item.type === 'group' || entry.item.type === 'computed') throw invalid(`Unbekanntes oder nicht beschreibbares Feld ${key}`);
        if ((entry.group?.id ?? undefined) !== groupId) throw invalid(`Feld ${itemId} gehört nicht zu dieser Gruppe`);
        if (groupId && !/^[a-z0-9-]{1,64}$/.test(instanceId!)) throw invalid('Ungültige Instanzkennung');
        const empty = (val.value === undefined || val.value === null || val.value === '' || (Array.isArray(val.value) && val.value.length === 0)) && !val.missing;
        if (empty) {
          delete merged[key];
          continue;
        }
        if (!val.missing) {
          const t = entry.item.type;
          const v = val.value;
          const ok =
            (t === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
            (t === 'date' && typeof v === 'string' && isValidIsoDate(v)) ||
            (t === 'multi' && Array.isArray(v)) ||
            (['text', 'single', 'yesno'].includes(t) && typeof v === 'string');
          if (!ok) throw invalid(`Typfehler bei ${entry.item.label}`, [{ path: key, message: 'Wert passt nicht zum Feldtyp' }]);
        }
        merged[key] = val.missing ? { missing: val.missing } : { value: val.value };
      }
      const evaluation = evaluateForm(r.schema, { answers: merged, instances });
      const inactive = new Set(evaluation.inactiveKeys);
      const upd = await c.query(
        `UPDATE response SET revision = revision + 1, instances = $3, updated_at = now(), started_at = COALESCE(started_at, now())
          WHERE id = $1 AND revision = $2 RETURNING revision`,
        [id, expected, JSON.stringify(instances)],
      );
      if (!upd.rows.length) throw await this.conflictError(c, r);
      const newRev = upd.rows[0].revision as number;
      // Antworten aktualisieren: nur geänderte Schlüssel schreiben, Aktivstatus neu setzen
      const removed = Object.keys(current.answers).filter((k) => !(k in merged));
      if (removed.length) await c.query('DELETE FROM answer WHERE response_id = $1 AND answer_key = ANY($2)', [id, removed]);
      for (const [key, a] of Object.entries(merged)) {
        const { itemId, instanceId } = parseAnswerKey(key);
        const t = idx.get(itemId)!.item.type;
        const v = a.value;
        const cols = {
          text: !a.missing && ['text', 'single', 'yesno'].includes(t) ? (v as string) : null,
          num: !a.missing && t === 'number' ? (v as number) : null,
          date: !a.missing && t === 'date' ? (v as string) : null,
          codes: !a.missing && t === 'multi' ? (v as string[]) : null,
        };
        await c.query(
          `INSERT INTO answer (response_id, center_id, answer_key, item_id, repeat_instance_id, value_text, value_number, value_date, value_codes, missing_reason, active, updated_revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (response_id, answer_key) DO UPDATE SET value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number,
             value_date = EXCLUDED.value_date, value_codes = EXCLUDED.value_codes, missing_reason = EXCLUDED.missing_reason, active = EXCLUDED.active,
             updated_revision = CASE WHEN (answer.value_text, answer.value_number, answer.value_date, answer.value_codes, answer.missing_reason, answer.active)
                IS DISTINCT FROM (EXCLUDED.value_text, EXCLUDED.value_number, EXCLUDED.value_date, EXCLUDED.value_codes, EXCLUDED.missing_reason, EXCLUDED.active)
                THEN EXCLUDED.updated_revision ELSE answer.updated_revision END, updated_at = now()`,
          [id, r.center_id, key, itemId, instanceId ?? '', cols.text, cols.num, cols.date, cols.codes, a.missing ?? null, !inactive.has(key), newRev],
        );
      }
      await c.query(
        `INSERT INTO response_revision (response_id, center_id, revision, answers, instances, inactive_keys, action, changed_by, changed_by_patient)
         VALUES ($1,$2,$3,$4,$5,$6,'entwurf',$7,$8)`,
        [id, r.center_id, newRev, JSON.stringify(merged), JSON.stringify(instances), [...inactive], w.kind === 'nutzer' ? w.actor.userId : null, w.kind === 'patient'],
      );
      await c.query(`UPDATE assessment_event SET status = 'begonnen', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status IN ('geplant','eingeladen')`, [r.assessment_event_id]);
      await this.audit.write(c, auditActor(w), { action: 'entwurf_speichern', objectType: 'antwort', objectId: id, centerId: r.center_id, revision: newRev, requestId: requestIdOf(req) });
      return { id, revision: newRev, status: r.status, evaluation, savedAt: new Date().toISOString(), request_id: requestIdOf(req) };
    });
  }

  private async conflictError(c: Tx, r: ResponseRow): Promise<ApiError> {
    const fresh = await c.query('SELECT revision, status, instances FROM response WHERE id = $1', [r.id]);
    const { answers } = await this.answers(c, r.id);
    const last = await c.query('SELECT rr.changed_by_patient, rr.created_at, u.display_name FROM response_revision rr LEFT JOIN app_user u ON u.id = rr.changed_by WHERE rr.response_id = $1 ORDER BY rr.revision DESC LIMIT 1', [r.id]);
    return conflict('KONFLIKT', undefined, {
      currentRevision: fresh.rows[0].revision,
      serverAnswers: answers,
      serverInstances: fresh.rows[0].instances,
      changedBy: last.rows[0]?.display_name ?? (last.rows[0]?.changed_by_patient ? 'Patient/in' : null),
      changedAt: last.rows[0]?.created_at ?? null,
    });
  }

  /** Bewusster Abschluss: serverseitige Validierung, Einwilligung, Zuständigkeit, Formularversion (F06). */
  async submit(id: string, ifMatch: string | undefined, w: Who, req: Request) {
    const expected = parseRevision(ifMatch);
    const actorKey = w.kind === 'nutzer' ? w.actor.userId : `patient:${w.patientId}`;
    const out = await this.idem.run(req, actorKey, `POST /responses/${id}/submit`, { expected }, async () => ({
      status: 200,
      body: await this.db.tx(scopeFor(w, 'case.write'), async (c) => {
        const r = await this.load(c, id, w);
        this.checkWrite(w, r, 'case.finalize');
        await this.gate(c, r);
        if (r.status === 'abgeschlossen') throw conflict('ZUSTAND_UNZULAESSIG', 'Der Bogen ist bereits abgeschlossen.');
        if (r.revision !== expected) throw await this.conflictError(c, r);
        const { answers } = await this.answers(c, id);
        const ev = evaluateForm(r.schema, { answers, instances: r.instances });
        const blocking = blockingIssues(ev);
        if (blocking.length) {
          throw new ApiError(422, 'VALIDIERUNG', `Abschluss nicht möglich: ${blocking.length} Angabe(n) fehlen oder sind ungültig.`, blocking.map((i) => ({ path: i.key, message: i.message })));
        }
        const upd = await c.query(
          `UPDATE response SET status = 'abgeschlossen', revision = revision + 1, submitted_at = now(), submitted_by = $3, updated_at = now()
            WHERE id = $1 AND revision = $2 RETURNING revision`,
          [id, expected, w.kind === 'nutzer' ? w.actor.userId : null],
        );
        if (!upd.rows.length) throw await this.conflictError(c, r);
        const newRev = upd.rows[0].revision as number;
        await c.query(
          `INSERT INTO response_revision (response_id, center_id, revision, answers, instances, inactive_keys, action, changed_by, changed_by_patient)
           VALUES ($1,$2,$3,$4,$5,$6,'abschluss',$7,$8)`,
          [id, r.center_id, newRev, JSON.stringify(answers), JSON.stringify(r.instances), ev.inactiveKeys, w.kind === 'nutzer' ? w.actor.userId : null, w.kind === 'patient'],
        );
        for (const s of ev.scores) {
          await c.query(
            `INSERT INTO derived_score (response_id, center_id, answer_key, algorithm, kind, value, reason, used_inputs, total_inputs, response_revision)
             VALUES ($1,$2,$3,$4,'neuberechnung',$5,$6,$7,$8,$9)`,
            [id, r.center_id, s.key, s.algorithm, s.value, s.reason ?? null, s.usedInputs, s.totalInputs, newRev],
          );
        }
        await c.query(
          `UPDATE assessment_event e SET status = 'abgeschlossen', completed_at = now()
            WHERE e.id = $1 AND NOT EXISTS (SELECT 1 FROM response x WHERE x.assessment_event_id = e.id AND x.status <> 'abgeschlossen')`,
          [r.assessment_event_id],
        );
        await this.audit.write(c, auditActor(w), { action: 'bogen_abschliessen', objectType: 'antwort', objectId: id, centerId: r.center_id, revision: newRev, requestId: requestIdOf(req) });
        return { id, status: 'abgeschlossen', revision: newRev, scores: ev.scores, request_id: requestIdOf(req) };
      }),
    }));
    return out.body;
  }

  /** Wiederöffnung nur mit Begründung; Historie bleibt in Revisionen erhalten. */
  async reopen(id: string, body: unknown, actor: Actor, req: Request) {
    const { reason } = parse(ReasonSchema, body);
    const w: Who = { kind: 'nutzer', actor };
    return this.db.tx(scopeFor(w, 'case.write'), async (c) => {
      const r = await this.load(c, id, w);
      this.checkWrite(w, r, 'case.finalize');
      if (r.status !== 'abgeschlossen') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur abgeschlossene Bögen können wieder geöffnet werden.');
      const upd = await c.query(`UPDATE response SET status = 'wiedereroeffnet', revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision`, [id]);
      const { answers, inactive } = await this.answers(c, id);
      await c.query(
        `INSERT INTO response_revision (response_id, center_id, revision, answers, instances, inactive_keys, action, reason, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,'wiedereroeffnung',$7,$8)`,
        [id, r.center_id, upd.rows[0].revision, JSON.stringify(answers), JSON.stringify(r.instances), inactive, reason, actor.userId],
      );
      await c.query(`UPDATE assessment_event SET status = 'begonnen', completed_at = NULL WHERE id = $1 AND status = 'abgeschlossen'`, [r.assessment_event_id]);
      await this.audit.write(c, actor, { action: 'bogen_wiedereroeffnen', objectType: 'antwort', objectId: id, centerId: r.center_id, reason, revision: upd.rows[0].revision, requestId: requestIdOf(req) });
      return { id, status: 'wiedereroeffnet', revision: upd.rows[0].revision };
    });
  }

  async history(id: string, actor: Actor) {
    const w: Who = { kind: 'nutzer', actor };
    return this.db.tx(scopeFor(w), async (c) => {
      await this.load(c, id, w);
      const { rows } = await c.query(
        `SELECT rr.revision, rr.action, rr.reason, rr.created_at, rr.inactive_keys, rr.changed_by_patient, u.display_name AS changed_by
           FROM response_revision rr LEFT JOIN app_user u ON u.id = rr.changed_by WHERE rr.response_id = $1 ORDER BY rr.revision DESC`,
        [id],
      );
      const scores = await c.query('SELECT answer_key, algorithm, kind, value, reason, response_revision, computed_at FROM derived_score WHERE response_id = $1 ORDER BY computed_at DESC', [id]);
      return { revisions: rows, scores: scores.rows };
    });
  }
}

export function parseRevision(ifMatch: string | undefined): number {
  if (!ifMatch) throw new ApiError(428, 'REVISION_FEHLT');
  const n = Number(String(ifMatch).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'REVISION_FEHLT', 'If-Match muss die Revision enthalten.');
  return n;
}

@ApiTags('Erhebungen')
@Controller('api/v1/responses')
export class ResponsesController {
  constructor(private readonly svc: ResponsesService) {}

  @Get(':id')
  @Perm('case.read')
  async get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get(id, { kind: 'nutzer', actor }, req);
    res.setHeader('ETag', `"${r.revision}"`);
    return r;
  }

  @Get(':id/history')
  @Perm('case.read')
  history(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.history(id, actor);
  }

  @Patch(':id/draft')
  @Perm('case.write')
  async draft(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveDraft(id, ifMatch, body, { kind: 'nutzer', actor }, req);
    res.setHeader('ETag', `"${r.revision}"`);
    return r;
  }

  @Post(':id/submit')
  @Perm('case.finalize')
  submit(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch: string, @Req() req: Request) {
    return this.svc.submit(id, ifMatch, { kind: 'nutzer', actor }, req);
  }

  @Post(':id/reopen')
  @Perm('case.finalize')
  reopen(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    return this.svc.reopen(id, body, actor, req);
  }
}
