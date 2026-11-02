import { Injectable } from '@nestjs/common';
import {
  addDays,
  CaptureMode,
  consentAllows,
  ConsentLike,
  FOLLOWUP_PLAN_V1,
  localTimeToUtc,
  planEvents,
  referenceDate,
  reminderIdempotencyKey,
  requiredScopesForCase,
  resolveQuestionnaires,
} from '@dart/domain';
import { AuditActor, Audit } from '../core/audit';
import { todayBerlin } from '../core/config';
import { Tx } from '../core/db';

export const PLAN_REF = `${FOLLOWUP_PLAN_V1.code}@${FOLLOWUP_PLAN_V1.version}`;

export interface CaseRow {
  id: string;
  case_no: string;
  center_id: string;
  patient_id: string;
  joint: 'knie';
  side: string;
  treatment_type: 'operativ' | 'konservativ';
  planned_op_date: string | null;
  actual_op_date: string | null;
  conservative_start_date: string | null;
  status: string;
  revision: number;
  surgeon_user_id: string | null;
  mode: CaptureMode;
  registers: string[];
  modules: string[];
}

export async function loadCase(c: Tx, caseId: string): Promise<CaseRow | null> {
  const { rows } = await c.query(
    `SELECT tc.*,
       (SELECT mode FROM capture_mode_history m WHERE m.case_id = tc.id AND m.valid_to IS NULL) AS mode,
       COALESCE((SELECT array_agg(register_code ORDER BY register_code) FROM case_register_membership r WHERE r.case_id = tc.id AND r.valid_to IS NULL), '{}') AS registers,
       COALESCE((SELECT array_agg(module_code ORDER BY module_code) FROM case_module cm WHERE cm.case_id = tc.id AND cm.active), '{}') AS modules
     FROM treatment_case tc WHERE tc.id = $1`,
    [caseId],
  );
  return rows[0] ?? null;
}

export async function patientConsents(c: Tx, patientId: string): Promise<ConsentLike[]> {
  const { rows } = await c.query('SELECT status, scopes FROM consent_record WHERE patient_id = $1', [patientId]);
  return rows;
}

/** Consent-Gate: transaktional vor jeder Erfassung, Befragung und jedem Versand. */
export async function consentGate(c: Tx, cs: CaseRow): Promise<{ ok: boolean; reason?: string }> {
  return consentAllows(await patientConsents(c, cs.patient_id), requiredScopesForCase(cs.mode, cs.registers));
}

export async function publishedVersionId(c: Tx, code: string): Promise<string | null> {
  const { rows } = await c.query(
    `SELECT qv.id FROM questionnaire_version qv JOIN questionnaire q ON q.id = qv.questionnaire_id
      WHERE q.code = $1 AND qv.status = 'veroeffentlicht'`,
    [code],
  );
  return rows[0]?.id ?? null;
}

export async function scienceApproved(c: Tx, centerId: string): Promise<boolean> {
  const today = todayBerlin();
  const { rows } = await c.query(
    'SELECT 1 FROM center_science_approval WHERE center_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)',
    [centerId, today],
  );
  return rows.length > 0;
}

@Injectable()
export class FollowUpService {
  constructor(private readonly audit: Audit) {}

  /** Legt fehlende Arzt-Baselinebögen gemäß Zuordnungsmatrix an (Basis je Version nur einmal). */
  async ensurePhysicianForms(c: Tx, cs: CaseRow, eventId: string): Promise<string[]> {
    const qs = resolveQuestionnaires({ joint: cs.joint, mode: cs.mode, treatment: cs.treatment_type, registers: cs.registers, modules: cs.modules }, 'arzt', 'BL');
    const missing: string[] = [];
    for (const q of qs) {
      const vid = await publishedVersionId(c, q.questionnaire);
      if (!vid) {
        missing.push(q.questionnaire);
        continue;
      }
      await c.query(
        `INSERT INTO response (center_id, case_id, assessment_event_id, questionnaire_version_id, module_code, audience)
         VALUES ($1,$2,$3,$4,$5,'arzt') ON CONFLICT (assessment_event_id, questionnaire_version_id) DO NOTHING`,
        [cs.center_id, cs.id, eventId, vid, q.module],
      );
    }
    return missing;
  }

  async ensurePatientForm(c: Tx, cs: CaseRow, eventId: string, timepoint: string): Promise<string | null> {
    const qs = resolveQuestionnaires({ joint: cs.joint, mode: cs.mode, treatment: cs.treatment_type, registers: cs.registers, modules: cs.modules }, 'patient', timepoint === 'BL' ? 'BL' : 'FU');
    let id: string | null = null;
    for (const q of qs) {
      const vid = await publishedVersionId(c, q.questionnaire);
      if (!vid) continue;
      const { rows } = await c.query(
        `INSERT INTO response (center_id, case_id, assessment_event_id, questionnaire_version_id, module_code, audience)
         VALUES ($1,$2,$3,$4,$5,'patient') ON CONFLICT (assessment_event_id, questionnaire_version_id) DO UPDATE SET updated_at = response.updated_at
         RETURNING id`,
        [cs.center_id, cs.id, eventId, vid, q.module],
      );
      id ??= rows[0].id;
    }
    return id;
  }

  /**
   * Aktiviert einen Fall nach erfülltem Consent-Gate: Zeitachse planen, Arztbögen anlegen,
   * Einladungen/Erinnerungen in die Outbox (idempotent). Ohne gültige Einwilligung: keine Erfassung.
   */
  async activateIfConsented(c: Tx, caseId: string, actor: AuditActor, requestId?: string): Promise<{ activated: boolean; reason?: string; missingForms: string[] }> {
    const cs = await loadCase(c, caseId);
    if (!cs) return { activated: false, reason: 'Fall nicht gefunden', missingForms: [] };
    if (cs.status === 'gesperrt' || cs.status === 'abgeschlossen') return { activated: false, reason: 'Fall gesperrt/abgeschlossen', missingForms: [] };
    const gate = await consentGate(c, cs);
    if (!gate.ok) return { activated: false, reason: gate.reason, missingForms: [] };
    const ref = referenceDate({ treatmentType: cs.treatment_type, plannedOpDate: cs.planned_op_date, actualOpDate: cs.actual_op_date, conservativeStartDate: cs.conservative_start_date });
    if (!ref.date) return { activated: false, reason: 'Bezugsdatum fehlt', missingForms: [] };

    if (cs.status === 'consent_ausstehend') {
      await c.query(`UPDATE treatment_case SET status = 'aktiv', revision = revision + 1 WHERE id = $1`, [cs.id]);
      await this.audit.write(c, actor, { action: 'fall_aktiviert', objectType: 'fall', objectId: cs.id, centerId: cs.center_id, requestId });
    }
    for (const ev of planEvents(ref.date, FOLLOWUP_PLAN_V1)) {
      await c.query(
        `INSERT INTO assessment_event (case_id, center_id, timepoint, plan_code, plan_version, reference_kind, due_date, window_start, window_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (case_id, timepoint, plan_code) DO NOTHING`,
        [cs.id, cs.center_id, ev.timepoint, FOLLOWUP_PLAN_V1.code, FOLLOWUP_PLAN_V1.version, ref.kind, ev.dueDate, ev.windowStart, ev.windowEnd],
      );
    }
    // Gesperrte offene Ereignisse nach erneut gültiger Einwilligung wieder öffnen
    await c.query(`UPDATE assessment_event SET status = 'geplant' WHERE case_id = $1 AND status = 'gesperrt'`, [cs.id]);
    const { rows: events } = await c.query('SELECT id, timepoint, window_start, window_end, status FROM assessment_event WHERE case_id = $1 AND source = $2', [cs.id, 'plan']);
    const bl = events.find((e) => e.timepoint === 'BL');
    const missingForms = bl ? await this.ensurePhysicianForms(c, cs, bl.id) : [];
    if (bl) await this.ensurePatientForm(c, cs, bl.id, 'BL');
    await this.scheduleMessages(c, cs, events);
    return { activated: true, missingForms };
  }

  /** Outbox-Einträge für Patienteneinladungen und Arzt-Erinnerung (Idempotenzschlüssel, keine Dubletten). */
  async scheduleMessages(c: Tx, cs: CaseRow, events: Array<{ id: string; timepoint: string; window_start: string; window_end: string; status: string }>) {
    const today = todayBerlin();
    const now = new Date();
    for (const e of events) {
      if (['abgeschlossen', 'abgebrochen', 'gesperrt'].includes(e.status)) continue;
      if (e.window_end < today) continue;
      const planned = localTimeToUtc(e.window_start > today ? e.window_start : today, FOLLOWUP_PLAN_V1.sendHourLocal);
      const at = planned < now ? now : planned;
      const key = reminderIdempotencyKey({ caseId: cs.id, eventId: e.id, ruleVersion: PLAN_REF, stage: 'einladung' });
      // Neuplanung nur, solange noch nicht versendet
      await c.query(
        `INSERT INTO outbox_message (idempotency_key, kind, center_id, patient_id, case_id, assessment_event_id, rule_version, stage, scheduled_at, next_attempt_at)
         VALUES ($1,'einladung',$2,$3,$4,$5,$6,'einladung',$7,$7)
         ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = now()
           WHERE outbox_message.status = 'ausstehend'`,
        [key, cs.center_id, cs.patient_id, cs.id, e.id, PLAN_REF, at],
      );
    }
    if (cs.treatment_type === 'operativ' && cs.planned_op_date) {
      const bl = events.find((e) => e.timepoint === 'BL');
      const at = localTimeToUtc(addDays(cs.planned_op_date, FOLLOWUP_PLAN_V1.reminders.physicianDaysAfterPlannedOp), FOLLOWUP_PLAN_V1.sendHourLocal);
      const key = reminderIdempotencyKey({ caseId: cs.id, eventId: bl?.id ?? 'ohne', ruleVersion: PLAN_REF, stage: 'arzt' });
      await c.query(
        `INSERT INTO outbox_message (idempotency_key, kind, center_id, patient_id, case_id, assessment_event_id, rule_version, stage, scheduled_at, next_attempt_at, payload)
         VALUES ($1,'arzt_erinnerung',$2,$3,$4,$5,$6,'arzt',$7,$7,$8)
         ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = now()
           WHERE outbox_message.status = 'ausstehend'`,
        [key, cs.center_id, cs.patient_id, cs.id, bl?.id ?? null, PLAN_REF, at, JSON.stringify({ surgeonUserId: cs.surgeon_user_id })],
      );
    }
  }

  /**
   * Datumskorrektur (F16): nur offene Termine werden neu geplant; abgeschlossene Erhebungen bleiben unverändert.
   */
  async replanOpenEvents(c: Tx, cs: CaseRow): Promise<{ replanned: number; unchanged: number }> {
    const ref = referenceDate({ treatmentType: cs.treatment_type, plannedOpDate: cs.planned_op_date, actualOpDate: cs.actual_op_date, conservativeStartDate: cs.conservative_start_date });
    if (!ref.date) return { replanned: 0, unchanged: 0 };
    let replanned = 0;
    let unchanged = 0;
    const plan = new Map(planEvents(ref.date, FOLLOWUP_PLAN_V1).map((e) => [e.timepoint, e]));
    const { rows } = await c.query(`SELECT id, timepoint, status FROM assessment_event WHERE case_id = $1 AND source = 'plan'`, [cs.id]);
    for (const e of rows) {
      const p = plan.get(e.timepoint);
      if (!p || ['abgeschlossen', 'abgebrochen', 'begonnen'].includes(e.status)) {
        unchanged++;
        continue;
      }
      await c.query('UPDATE assessment_event SET due_date = $2, window_start = $3, window_end = $4, reference_kind = $5 WHERE id = $1', [e.id, p.dueDate, p.windowStart, p.windowEnd, ref.kind]);
      replanned++;
    }
    const { rows: events } = await c.query('SELECT id, timepoint, window_start, window_end, status FROM assessment_event WHERE case_id = $1 AND source = $2', [cs.id, 'plan']);
    if (cs.status === 'aktiv') await this.scheduleMessages(c, cs, events);
    return { replanned, unchanged };
  }

  /** Widerruf/Sperre: Tokens, Sitzungen und geplante Versandereignisse sofort wirkungslos machen. */
  async blockPatient(c: Tx, patientId: string, reason: string) {
    await c.query(`UPDATE invitation SET status = 'widerrufen', revoked_at = now() WHERE patient_id = $1 AND status = 'aktiv'`, [patientId]);
    await c.query(`UPDATE patient_session SET revoked_at = now() WHERE patient_id = $1 AND revoked_at IS NULL`, [patientId]);
    await c.query(
      `UPDATE outbox_message SET status = 'storniert', cancel_reason = $2, updated_at = now()
        WHERE patient_id = $1 AND status IN ('ausstehend','fehlgeschlagen','unklar')`,
      [patientId, reason],
    );
    await c.query(
      `UPDATE assessment_event SET status = 'gesperrt' WHERE case_id IN (SELECT id FROM treatment_case WHERE patient_id = $1) AND status IN ('geplant','eingeladen','begonnen')`,
      [patientId],
    );
  }
}
