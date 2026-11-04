import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreatePatientCaseSchema, PageQuerySchema, ReasonSchema } from '@dart/contracts';
import { ageGroup, CONSENT_STATUS_LABELS, ConsentStatus, displayStatus, EventStatus, MODULES, OPS_EXAMPLES, Permission, resolveQuestionnaires } from '@dart/domain';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm, readableCenters, requirePerm } from '../core/auth';
import { todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { ApiError, conflict, notFound, requestIdOf } from '../core/errors';
import { Idempotency, parse } from '../core/http';
import { VaultClient } from '../core/vault-client';
import { CaseRow, FollowUpService, loadCase, scienceApproved } from './followup.service';

const PSEUDO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newPseudonym(): string {
  const b = randomBytes(8);
  let s = 'P-';
  for (let i = 0; i < 8; i++) s += PSEUDO_ALPHABET[b[i] % PSEUDO_ALPHABET.length];
  return s;
}

/** Fallzugriff mit Objekt-, Zentrums- und Rollenprüfung. Fremde Fälle sind nicht von fehlenden unterscheidbar. */
export async function caseForActor(c: Tx, actor: Actor, caseId: string, perm: Permission): Promise<CaseRow> {
  const cs = await loadCase(c, caseId);
  if (!cs || !can(actor, perm, cs.center_id)) throw notFound();
  return cs;
}

@ApiTags('Fälle')
@Controller('api/v1')
export class CasesController {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly vault: VaultClient,
    private readonly followup: FollowUpService,
    private readonly idem: Idempotency,
  ) {}

  /** Dashboard-Liste mit serverseitiger Pagination und Filtern (F03). */
  @Get('cases')
  @Perm('case.read')
  async list(@CurrentActor() actor: Actor, @Query() query: Record<string, string>, @Req() req: Request) {
    const q = parse(PageQuerySchema, query);
    const centers = readableCenters(actor);
    if (q.centerId && !centers.includes(q.centerId)) throw notFound();
    const today = todayBerlin();
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('$?', `$${args.length}`));
    };
    if (q.centerId) add('tc.center_id = $?', q.centerId);
    if (q.surgeonId) add('tc.surgeon_user_id = $?', q.surgeonId);
    if (q.joint) add('tc.joint = $?', q.joint);
    if (q.mode) add('m.mode = $?', q.mode);
    if (q.register) add('EXISTS (SELECT 1 FROM case_register_membership r WHERE r.case_id = tc.id AND r.valid_to IS NULL AND r.register_code = $?)', q.register);
    if (q.module) add('EXISTS (SELECT 1 FROM case_module cm WHERE cm.case_id = tc.id AND cm.active AND cm.module_code = $?)', q.module);
    if (q.procedure) {
      args.push(q.procedure);
      where.push(`EXISTS (SELECT 1 FROM procedure pr WHERE pr.case_id = tc.id AND (pr.concept_code = $${args.length} OR pr.ops_code = $${args.length}))`);
    }
    if (q.from) add('COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) >= $?', q.from);
    if (q.to) add('COALESCE(tc.actual_op_date, tc.planned_op_date, tc.conservative_start_date) <= $?', q.to);
    if (q.status === 'arztbogen_offen') where.push(`EXISTS (SELECT 1 FROM response r WHERE r.case_id = tc.id AND r.audience = 'arzt' AND r.status <> 'abgeschlossen')`);
    else if (q.status === 'ueberfaellig') {
      args.push(today);
      where.push(`EXISTS (SELECT 1 FROM assessment_event e WHERE e.case_id = tc.id AND e.status IN ('geplant','eingeladen','begonnen') AND e.window_end < $${args.length})`);
    } else if (q.status) add('tc.status = $?', q.status);
    if (q.q) {
      const term = q.q.trim();
      args.push(`%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      const i = args.length;
      // Pseudonym-/Fallnummernsuche im Forschungskern; Klarnamensuche separat über den Vault
      where.push(`(p.pseudonym ILIKE $${i} OR tc.case_no ILIKE $${i})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (q.page - 1) * q.pageSize;
    return this.db.tx({ centerIds: centers }, async (c) => {
      const base = `FROM treatment_case tc JOIN patient p ON p.id = tc.patient_id
        LEFT JOIN capture_mode_history m ON m.case_id = tc.id AND m.valid_to IS NULL ${whereSql}`;
      const total = await c.query(`SELECT count(*)::int AS n, count(DISTINCT tc.patient_id)::int AS patients ${base}`, args);
      const { rows } = await c.query(
        `SELECT tc.id, tc.case_no, tc.center_id, ce.name AS center_name, p.pseudonym, tc.joint, tc.side, tc.treatment_type,
                tc.planned_op_date, tc.actual_op_date, tc.conservative_start_date, tc.status, m.mode,
                COALESCE((SELECT array_agg(register_code ORDER BY register_code) FROM case_register_membership r WHERE r.case_id = tc.id AND r.valid_to IS NULL), '{}') AS registers,
                COALESCE((SELECT array_agg(module_code ORDER BY module_code) FROM case_module cm WHERE cm.case_id = tc.id AND cm.active), '{}') AS modules,
                (SELECT count(*)::int FROM response r WHERE r.case_id = tc.id AND r.audience = 'arzt' AND r.status <> 'abgeschlossen') AS open_physician_forms,
                (SELECT cr.status FROM consent_record cr WHERE cr.patient_id = tc.patient_id ORDER BY (cr.status = 'gueltig') DESC, cr.created_at DESC LIMIT 1) AS consent_status,
                u.display_name AS surgeon_name
           ${base.replace('LEFT JOIN capture_mode_history', 'JOIN center ce ON ce.id = tc.center_id LEFT JOIN app_user u ON u.id = tc.surgeon_user_id LEFT JOIN capture_mode_history')}
          ORDER BY tc.created_at DESC LIMIT ${q.pageSize} OFFSET ${offset}`,
        args,
      );
      await this.audit.write(c, actor, { action: 'fallliste_lesen', objectType: 'fall', objectId: null, requestId: requestIdOf(req) });
      return {
        items: rows.map((r) => ({ ...r, consent_status_label: r.consent_status ? CONSENT_STATUS_LABELS[r.consent_status as ConsentStatus] : 'Fehlt' })),
        page: q.page,
        pageSize: q.pageSize,
        totalCases: total.rows[0].n,
        totalPatients: total.rows[0].patients,
        stichtag: today,
      };
    });
  }

  /** Aufgaben und Kennzahlen (Fälle und Patienten getrennt). */
  @Get('dashboard/tasks')
  @Perm('case.read')
  async tasks(@CurrentActor() actor: Actor) {
    const centers = readableCenters(actor);
    const today = todayBerlin();
    return this.db.tx({ centerIds: centers }, async (c) => {
      const one = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0].n as number;
      return {
        stichtag: today,
        patients: await one('SELECT count(*)::int AS n FROM patient'),
        cases: await one('SELECT count(*)::int AS n FROM treatment_case'),
        consentMissing: await one(`SELECT count(*)::int AS n FROM treatment_case WHERE status = 'consent_ausstehend'`),
        evidenceToReview: await one(`SELECT count(*)::int AS n FROM consent_record WHERE status = 'upload_in_pruefung'`),
        physicianFormsOpen: await one(`SELECT count(*)::int AS n FROM response WHERE audience = 'arzt' AND status <> 'abgeschlossen'`),
        followUpsDue: await one(`SELECT count(*)::int AS n FROM assessment_event WHERE status IN ('geplant','eingeladen','begonnen') AND window_start <= $1 AND window_end >= $1 AND timepoint <> 'BL'`, [today]),
        overdue: await one(`SELECT count(*)::int AS n FROM assessment_event WHERE status IN ('geplant','eingeladen','begonnen') AND window_end < $1`, [today]),
      };
    });
  }

  @Get('cases/:id')
  @Perm('case.read')
  async detail(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const today = todayBerlin();
    return this.db.tx({ centerIds: readableCenters(actor) }, async (c) => {
      const cs = await caseForActor(c, actor, id, 'case.read');
      const patient = (await c.query('SELECT id, pseudonym, vault_ref, synthetic, restricted_at, restricted_reason FROM patient WHERE id = $1', [cs.patient_id])).rows[0];
      const consents = (await c.query(
        `SELECT cr.id, cr.status, cr.method, cr.scopes, cr.signed_date, cr.uploaded_at, cr.reviewed_at, cr.rejection_reason, cr.created_at, cr.revision,
                d.title AS document_title, d.version AS document_version
           FROM consent_record cr LEFT JOIN consent_document_version d ON d.id = cr.document_version_id
          WHERE cr.patient_id = $1 ORDER BY cr.created_at DESC`,
        [cs.patient_id],
      )).rows;
      const events = (await c.query(
        `SELECT e.id, e.timepoint, e.due_date, e.window_start, e.window_end, e.status, e.reference_kind, e.completed_at, e.source
           FROM assessment_event e WHERE e.case_id = $1
          ORDER BY e.due_date NULLS LAST`,
        [id],
      )).rows.map((e) => ({ ...e, display_status: displayStatus(e.status as EventStatus, e.window_end ?? '9999-12-31', today) }));
      const responses = (await c.query(
        `SELECT r.id, r.status, r.audience, r.module_code, r.revision, r.submitted_at, r.assessment_event_id, q.code AS questionnaire_code, q.title, qv.version
           FROM response r JOIN questionnaire_version qv ON qv.id = r.questionnaire_version_id JOIN questionnaire q ON q.id = qv.questionnaire_id
          WHERE r.case_id = $1 ORDER BY r.created_at`,
        [id],
      )).rows;
      const procedures = (await c.query('SELECT concept_code, ops_code, ops_version, source FROM procedure WHERE case_id = $1', [id])).rows;
      const modeHistory = (await c.query('SELECT mode, valid_from, valid_to, reason FROM capture_mode_history WHERE case_id = $1 ORDER BY valid_from', [id])).rows;
      const otherCases = (await c.query('SELECT id, case_no, joint, side, status FROM treatment_case WHERE patient_id = $1 AND id <> $2', [cs.patient_id, id])).rows;
      const outbox = (await c.query(
        `SELECT kind, stage, status, scheduled_at, attempts, cancel_reason FROM outbox_message WHERE case_id = $1 ORDER BY scheduled_at`,
        [id],
      )).rows;
      await this.audit.write(c, actor, { action: 'fall_lesen', objectType: 'fall', objectId: id, centerId: cs.center_id, requestId: requestIdOf(req) });
      const expectedForms = resolveQuestionnaires({ joint: cs.joint, mode: cs.mode, treatment: cs.treatment_type, registers: cs.registers, modules: cs.modules }, 'arzt', 'BL');
      return {
        case: { ...cs, patient_id: undefined },
        patient: { id: patient.id, pseudonym: patient.pseudonym, synthetic: patient.synthetic, restrictedAt: patient.restricted_at, restrictedReason: patient.restricted_reason },
        consents,
        events,
        responses,
        procedures,
        modeHistory,
        otherCases,
        outbox,
        expectedForms,
        canFinalize: can(actor, 'case.finalize', cs.center_id),
        canSeeIdentity: can(actor, 'identity.read', cs.center_id),
        canManageConsent: can(actor, 'consent.manage', cs.center_id),
        canReviewConsent: can(actor, 'consent.review', cs.center_id),
      };
    });
  }

  /** Identität nur über den autorisierten Vault-Pfad (getrennte Sicherheitsgrenze). */
  @Get('cases/:id/identity')
  @Perm('identity.read')
  async identity(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const centers = centersWith(actor, 'identity.read');
    const { vaultRef, centerId } = await this.db.tx({ centerIds: centers }, async (c) => {
      const cs = await caseForActor(c, actor, id, 'identity.read');
      const p = (await c.query('SELECT vault_ref FROM patient WHERE id = $1', [cs.patient_id])).rows[0];
      await this.audit.write(c, actor, { action: 'identitaet_lesen', objectType: 'patient', objectId: cs.patient_id, centerId: cs.center_id, requestId: requestIdOf(req) });
      return { vaultRef: p.vault_ref as string, centerId: cs.center_id };
    });
    const ident = await this.vault.getIdentity({ centerIds: [centerId], actor: actor.userId, requestId: requestIdOf(req) }, vaultRef);
    return { firstName: ident.firstName, lastName: ident.lastName, email: ident.email, birthDate: ident.birthDate, hasAccessCode: ident.hasAccessCode };
  }

  /** Klarnamensuche über den Vault; Ergebnis nur Patienten der eigenen Zentren. */
  @Post('patients/search-by-name')
  @Perm('identity.read')
  async searchByName(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const { lastName } = parse(z.object({ lastName: z.string().trim().min(2).max(100) }), body);
    const centers = centersWith(actor, 'identity.read');
    const refs = await this.vault.search({ centerIds: centers, actor: actor.userId, requestId: requestIdOf(req) }, lastName);
    if (refs.length === 0) return { items: [] };
    return this.db.tx({ centerIds: centers }, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id AS patient_id, p.pseudonym, tc.id AS case_id, tc.case_no, tc.joint, tc.side, tc.status
           FROM patient p LEFT JOIN treatment_case tc ON tc.patient_id = p.id WHERE p.vault_ref = ANY($1::uuid[])`,
        [refs],
      );
      await this.audit.write(c, actor, { action: 'klarnamensuche', objectType: 'patient', requestId: requestIdOf(req) });
      return { items: rows };
    });
  }

  /** Dreistufige Anlage (F04/F05): Patient/Einwilligung, Gelenk/Behandlung, Datum/Register/Modus. */
  @Post('cases')
  @Perm('case.write')
  async create(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.idem.run(req, actor.userId, 'POST /cases', body, async () => ({ status: 201, body: await this.createCase(actor, body, req) }));
    res.status(r.status);
    if (r.replay) res.setHeader('Idempotent-Replay', 'true');
    return r.body;
  }

  private async createCase(actor: Actor, body: unknown, req: Request) {
    const b = parse(CreatePatientCaseSchema, body);
    requirePerm(actor, 'case.write', b.centerId);
    if (b.joint !== 'knie') throw new ApiError(400, 'VALIDIERUNG', 'Im Prototyp ist nur das Kniegelenk freigeschaltet; weitere Gelenke sind architektonisch vorbereitet.');
    const moduleCodes = new Set(MODULES.map((m) => m.code));
    for (const m of b.modules) if (!moduleCodes.has(m)) throw new ApiError(400, 'VALIDIERUNG', `Unbekanntes Modul ${m}`);
    for (const p of b.procedures) {
      if (!OPS_EXAMPLES.some((o) => o.code === p.code && o.version === p.version && o.concept === p.concept)) throw new ApiError(400, 'VALIDIERUNG', `Unbekannter Eingriff ${p.code}/${p.concept}`);
    }
    let vaultRef: string | null = null;
    if ('firstName' in b.patient) {
      requirePerm(actor, 'identity.write', b.centerId);
      const created = await this.vault.createIdentity(
        { centerIds: [b.centerId], actor: actor.userId, requestId: requestIdOf(req) },
        { centerId: b.centerId, firstName: b.patient.firstName, lastName: b.patient.lastName, email: b.patient.email || null, birthDate: b.patient.birthDate || null, synthetic: true },
      );
      vaultRef = created.vaultRef;
    }
    return this.db.tx({ centerIds: centersWith(actor, 'case.write') }, async (c) => {
      if (b.mode === 'science' && !(await scienceApproved(c, b.centerId))) throw conflict('SCIENCE_NICHT_FREIGEGEBEN');
      if (b.surgeonUserId) {
        const s = await c.query(`SELECT 1 FROM user_center_role WHERE user_id = $1 AND center_id = $2 AND role = 'arzt'`, [b.surgeonUserId, b.centerId]);
        if (!s.rows.length) throw new ApiError(400, 'VALIDIERUNG', 'Operateur gehört nicht zum Zentrum');
      }
      let patientId: string;
      let birthDate: string | null = null;
      if ('existingPatientId' in b.patient) {
        const p = await c.query('SELECT id, center_id, vault_ref FROM patient WHERE id = $1', [b.patient.existingPatientId]);
        if (!p.rows[0] || p.rows[0].center_id !== b.centerId) throw notFound();
        patientId = p.rows[0].id;
        // Geburtsdatum nur zur Berechnung der Altersgruppe aus dem Vault; es wird nicht im Kern gespeichert
        if (can(actor, 'identity.read', b.centerId)) {
          birthDate = (await this.vault.getIdentity({ centerIds: [b.centerId], actor: actor.userId, requestId: requestIdOf(req) }, p.rows[0].vault_ref).catch(() => null))?.birthDate ?? null;
        }
      } else {
        birthDate = b.patient.birthDate || null;
        const p = await c.query('INSERT INTO patient (center_id, pseudonym, vault_ref, created_by, sex) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.centerId, newPseudonym(), vaultRef, actor.userId, b.patient.sex ?? null]);
        patientId = p.rows[0].id;
        await this.audit.write(c, actor, { action: 'patient_anlegen', objectType: 'patient', objectId: patientId, centerId: b.centerId, requestId: requestIdOf(req) });
      }
      const ins = await c.query(
        `INSERT INTO treatment_case (center_id, patient_id, joint, side, treatment_type, surgeon_user_id, planned_op_date, actual_op_date, conservative_start_date, created_by, age_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, case_no`,
        [b.centerId, patientId, b.joint, b.side, b.treatmentType, b.surgeonUserId ?? null, b.treatmentType === 'operativ' ? b.plannedOpDate ?? null : null, b.treatmentType === 'operativ' ? b.actualOpDate ?? null : null, b.treatmentType === 'konservativ' ? b.conservativeStartDate : null, actor.userId,
          birthDate ? ageGroup(birthDate, (b.treatmentType === 'konservativ' ? b.conservativeStartDate : b.actualOpDate ?? b.plannedOpDate)!) : null],
      );
      const caseId = ins.rows[0].id as string;
      for (const reg of [...new Set(b.registers)]) await c.query('INSERT INTO case_register_membership (case_id, center_id, register_code) VALUES ($1,$2,$3)', [caseId, b.centerId, reg]);
      await c.query('INSERT INTO capture_mode_history (case_id, center_id, mode, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [caseId, b.centerId, b.mode, 'Fallanlage', actor.userId]);
      for (const m of [...new Set(b.modules)]) await c.query('INSERT INTO case_module (case_id, center_id, module_code, added_by) VALUES ($1,$2,$3,$4)', [caseId, b.centerId, m, actor.userId]);
      for (const p of b.procedures) await c.query('INSERT INTO procedure (case_id, center_id, concept_code, ops_code, ops_version) VALUES ($1,$2,$3,$4,$5)', [caseId, b.centerId, p.concept, p.code, p.version]);
      await this.audit.write(c, actor, { action: 'fall_anlegen', objectType: 'fall', objectId: caseId, centerId: b.centerId, requestId: requestIdOf(req) });
      const act = await this.followup.activateIfConsented(c, caseId, actor, requestIdOf(req));
      return { id: caseId, caseNo: ins.rows[0].case_no, patientId, activated: act.activated, gate: act.reason ?? null, revision: 1, request_id: requestIdOf(req) };
    });
  }

  /** Datumskorrektur mit Begründung; plant nur offene Termine neu (F16). */
  @Post('cases/:id/dates')
  @Perm('case.write')
  async correctDates(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
    const b = parse(ReasonSchema.extend({ plannedOpDate: iso, actualOpDate: iso, conservativeStartDate: iso, revision: z.number().int() }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'case.write') }, async (c) => {
      const cs = await caseForActor(c, actor, id, 'case.write');
      if (cs.revision !== b.revision) throw conflict('KONFLIKT', undefined, { currentRevision: cs.revision });
      const upd = await c.query(
        `UPDATE treatment_case SET planned_op_date = COALESCE($2, planned_op_date), actual_op_date = COALESCE($3, actual_op_date),
                conservative_start_date = COALESCE($4, conservative_start_date), revision = revision + 1
          WHERE id = $1 AND revision = $5 RETURNING revision`,
        [id, b.plannedOpDate ?? null, b.actualOpDate ?? null, b.conservativeStartDate ?? null, b.revision],
      );
      if (!upd.rows.length) throw conflict('KONFLIKT');
      const fresh = (await loadCase(c, id))!;
      const result = await this.followup.replanOpenEvents(c, fresh);
      await this.audit.write(c, actor, { action: 'datum_korrigiert', objectType: 'fall', objectId: id, centerId: cs.center_id, reason: b.reason, revision: upd.rows[0].revision, requestId: requestIdOf(req) });
      return { ...result, revision: upd.rows[0].revision };
    });
  }

  /** Moduswechsel mit Gültigkeitsdatum; Basic-Daten werden nicht rückwirkend zu Science (F07). */
  @Post('cases/:id/mode')
  @Perm('case.write')
  async changeMode(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(ReasonSchema.extend({ mode: z.enum(['basic', 'science']) }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'case.write') }, async (c) => {
      const cs = await caseForActor(c, actor, id, 'case.write');
      if (cs.mode === b.mode) throw conflict('ZUSTAND_UNZULAESSIG', 'Der Fall ist bereits in diesem Modus.');
      if (b.mode === 'science' && !(await scienceApproved(c, cs.center_id))) throw conflict('SCIENCE_NICHT_FREIGEGEBEN');
      await c.query('UPDATE capture_mode_history SET valid_to = now() WHERE case_id = $1 AND valid_to IS NULL', [id]);
      await c.query('INSERT INTO capture_mode_history (case_id, center_id, mode, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [id, cs.center_id, b.mode, b.reason, actor.userId]);
      await c.query('UPDATE treatment_case SET revision = revision + 1 WHERE id = $1', [id]);
      await this.audit.write(c, actor, { action: 'modus_gewechselt', objectType: 'fall', objectId: id, centerId: cs.center_id, reason: b.reason, requestId: requestIdOf(req) });
      const act = await this.followup.activateIfConsented(c, id, actor, requestIdOf(req));
      return { mode: b.mode, activated: act.activated, gate: act.reason ?? null };
    });
  }
}
