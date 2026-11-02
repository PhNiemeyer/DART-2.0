import { backoffSeconds, consentAllows, ConsentScope, FOLLOWUP_PLAN_V1, reminderIdempotencyKey, reminderTimes, requiredScopesForCase } from '@dart/domain';
import { createHash, randomBytes } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { inviteText, MailProvider, physicianText, SendError } from './mail';

export const MAX_ATTEMPTS = 5;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface WorkerDeps {
  pool: Pool;
  mail: MailProvider;
  /** Kontaktabfrage beim Vault (eigene Sicherheitsgrenze, Worker-Token). */
  contact(vaultRef: string, centerId: string): Promise<string | null>;
  webUrl: string;
  messageDomain: string;
  staffDomain: string;
  now?: () => Date;
}

interface OutboxRow {
  id: string;
  idempotency_key: string;
  kind: 'einladung' | 'erinnerung' | 'arzt_erinnerung';
  center_id: string;
  patient_id: string;
  case_id: string;
  assessment_event_id: string | null;
  rule_version: string;
  stage: string;
  payload: Record<string, unknown>;
  attempts: number;
  status: string;
  provider_message_id: string | null;
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function audit(c: PoolClient, action: string, objectId: string, centerId: string | null, result: 'erfolg' | 'abgelehnt' | 'fehler', reason?: string) {
  await c.query(
    `INSERT INTO audit_event (actor_kind, center_id, action, object_type, object_id, result, reason) VALUES ('worker',$1,$2,'versand',$3,$4,$5)`,
    [centerId, action, objectId, result, reason ?? null],
  );
}

/**
 * Nachrichten beanspruchen (SKIP LOCKED, Lease). Hängengebliebene „in_versand“-Einträge
 * mit abgelaufener Lease gelten als „unklar“ und werden vor erneutem Versand abgeglichen.
 */
export async function claim(pool: Pool, limit = 10): Promise<OutboxRow[]> {
  await pool.query(`UPDATE outbox_message SET status = 'unklar', last_error = 'Lease abgelaufen', updated_at = now() WHERE status = 'in_versand' AND locked_until < now()`);
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT id, status AS prev_status FROM outbox_message
        WHERE status IN ('ausstehend','fehlgeschlagen','unklar') AND scheduled_at <= now() AND next_attempt_at <= now()
        ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $1)
     UPDATE outbox_message o SET status = 'in_versand', locked_until = now() + interval '2 minutes', attempts = o.attempts + 1, updated_at = now()
       FROM picked WHERE o.id = picked.id
     RETURNING o.*, picked.prev_status`,
    [limit],
  );
  return rows;
}

async function finish(c: PoolClient, m: OutboxRow, status: string, extra: { providerId?: string | null; error?: string | null; cancel?: string | null; result: string; nextAttemptSec?: number }) {
  await c.query(
    `UPDATE outbox_message SET status = $2, provider_message_id = COALESCE($3, provider_message_id), last_error = $4, cancel_reason = COALESCE($5, cancel_reason),
            next_attempt_at = now() + make_interval(secs => $6), locked_until = NULL, updated_at = now() WHERE id = $1`,
    [m.id, status, extra.providerId ?? null, extra.error ?? null, extra.cancel ?? null, extra.nextAttemptSec ?? 0],
  );
  await c.query(
    `INSERT INTO delivery_attempt (outbox_id, attempt_no, finished_at, result, provider_message_id, error_code) VALUES ($1,$2,now(),$3,$4,$5)
     ON CONFLICT (outbox_id, attempt_no) DO NOTHING`,
    [m.id, m.attempts, extra.result, extra.providerId ?? null, extra.error ?? null],
  );
}

/** Erneute Einwilligungsprüfung unmittelbar vor dem Versand (F17). */
async function consentCheck(c: PoolClient, m: OutboxRow, needContact: boolean): Promise<string | null> {
  const cs = (await c.query(
    `SELECT tc.status, (SELECT mode FROM capture_mode_history h WHERE h.case_id = tc.id AND h.valid_to IS NULL) AS mode,
            COALESCE((SELECT array_agg(register_code) FROM case_register_membership r WHERE r.case_id = tc.id AND r.valid_to IS NULL), '{}') AS registers
       FROM treatment_case tc WHERE tc.id = $1`,
    [m.case_id],
  )).rows[0];
  if (!cs) return 'Fall nicht gefunden';
  const consents = (await c.query('SELECT status, scopes FROM consent_record WHERE patient_id = $1', [m.patient_id])).rows;
  const req: ConsentScope[] = requiredScopesForCase(cs.mode, cs.registers);
  if (needContact) req.push('kontakt_followup');
  const g = consentAllows(consents, req);
  return g.ok ? null : g.reason ?? 'Einwilligung fehlt';
}

export async function processMessage(deps: WorkerDeps, m: OutboxRow & { prev_status?: string }): Promise<string> {
  const { pool, mail } = deps;
  const messageId = `<outbox-${m.id}@${deps.messageDomain}>`;
  // 1) Fachliche Vorprüfung (Consent, Ereignisstatus) – ohne Versand
  const pre = await inTx(pool, async (c) => {
    const reason = await consentCheck(c, m, m.kind !== 'arzt_erinnerung');
    if (reason) {
      await finish(c, m, 'storniert', { cancel: reason, result: 'storniert' });
      await audit(c, 'versand_storniert', m.id, m.center_id, 'abgelehnt', reason);
      return { stop: 'storniert' as const };
    }
    if (m.assessment_event_id && m.kind !== 'arzt_erinnerung') {
      const ev = (await c.query('SELECT status FROM assessment_event WHERE id = $1', [m.assessment_event_id])).rows[0];
      if (!ev || ['abgeschlossen', 'gesperrt', 'abgebrochen'].includes(ev.status)) {
        await finish(c, m, 'storniert', { cancel: `Erhebung ${ev?.status ?? 'unbekannt'}`, result: 'storniert' });
        return { stop: 'storniert' as const };
      }
    }
    if (m.kind === 'arzt_erinnerung') {
      const open = (await c.query(`SELECT count(*)::int AS n FROM response WHERE case_id = $1 AND audience = 'arzt' AND status <> 'abgeschlossen'`, [m.case_id])).rows[0].n;
      if (open === 0) {
        await finish(c, m, 'storniert', { cancel: 'Arztbögen bereits abgeschlossen', result: 'storniert' });
        return { stop: 'storniert' as const };
      }
      const info = (await c.query('SELECT case_no FROM treatment_case WHERE id = $1', [m.case_id])).rows[0];
      return { stop: null, physician: { caseNo: info.case_no as string, open: open as number } };
    }
    const p = (await c.query('SELECT vault_ref FROM patient WHERE id = $1', [m.patient_id])).rows[0];
    return { stop: null, vaultRef: p.vault_ref as string };
  });
  if (pre.stop) return pre.stop;

  // 2) Bei unklarem Vorergebnis zuerst beim Anbieter abgleichen – nie blind doppelt senden
  if (m.prev_status === 'unklar' || m.provider_message_id) {
    try {
      const found = await mail.find(messageId);
      if (found) {
        await inTx(pool, async (c) => {
          await finish(c, m, 'versendet', { providerId: found, result: 'abgeglichen' });
          if (m.kind === 'einladung') await scheduleReminders(c, m, deps.now?.() ?? new Date());
        });
        return 'abgeglichen';
      }
    } catch (e) {
      await inTx(pool, (c) => finish(c, m, 'unklar', { error: (e as Error).message, result: 'unklar', nextAttemptSec: backoffSeconds(m.attempts) }));
      return 'unklar';
    }
  }

  // 3) Empfänger und Inhalt vorbereiten
  let to: string | null;
  let content: { subject: string; text: string };
  if (pre.physician) {
    const surgeon = (await pool.query('SELECT u.username FROM app_user u WHERE u.id = $1', [m.payload?.surgeonUserId ?? null])).rows[0];
    to = surgeon ? `${surgeon.username}@${deps.staffDomain}` : `zentrum-${m.center_id.slice(0, 8)}@${deps.staffDomain}`;
    content = physicianText({ caseNo: pre.physician.caseNo, open: pre.physician.open, webUrl: deps.webUrl });
  } else {
    to = await deps.contact(pre.vaultRef!, m.center_id);
    if (!to) {
      await inTx(pool, async (c) => {
        await finish(c, m, 'storniert', { cancel: 'Keine E-Mail-Adresse hinterlegt', result: 'storniert' });
      });
      return 'storniert';
    }
    // Neuer einmaliger Token je Versandversuch; frühere Tokens dieses Ereignisses werden wirkungslos
    const token = randomBytes(32).toString('base64url');
    await inTx(pool, async (c) => {
      await c.query(`UPDATE invitation SET status = 'widerrufen', revoked_at = now() WHERE assessment_event_id = $1 AND status = 'aktiv'`, [m.assessment_event_id]);
      await c.query(
        `INSERT INTO invitation (center_id, patient_id, case_id, assessment_event_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4,'befragung',$5, now() + interval '14 days')`,
        [m.center_id, m.patient_id, m.case_id, m.assessment_event_id, sha256(token)],
      );
    });
    content = inviteText({ link: `${deps.webUrl}/portal/einladung#t=${token}`, reminder: m.kind === 'erinnerung', resend: m.stage.startsWith('erneut-') });
  }

  // 4) Versand
  try {
    const r = await mail.send({ messageId, to, ...content });
    await inTx(pool, async (c) => {
      await finish(c, m, 'versendet', { providerId: r.providerId, result: 'versendet' });
      if (m.assessment_event_id && m.kind !== 'arzt_erinnerung') await c.query(`UPDATE assessment_event SET status = 'eingeladen' WHERE id = $1 AND status = 'geplant'`, [m.assessment_event_id]);
      if (m.kind === 'einladung') await scheduleReminders(c, m, deps.now?.() ?? new Date());
      await audit(c, `versand_${m.kind}`, m.id, m.center_id, 'erfolg');
    });
    return 'versendet';
  } catch (e) {
    const kind = e instanceof SendError ? e.kind : 'unklar';
    const dead = m.attempts >= MAX_ATTEMPTS;
    await inTx(pool, async (c) => {
      await finish(c, m, dead ? 'dead_letter' : kind === 'unklar' ? 'unklar' : 'fehlgeschlagen', {
        error: (e as Error).message.slice(0, 200),
        result: kind === 'unklar' ? 'unklar' : 'fehler',
        nextAttemptSec: backoffSeconds(m.attempts),
      });
      if (dead) await audit(c, 'versand_dead_letter', m.id, m.center_id, 'fehler', (e as Error).message.slice(0, 200));
    });
    return dead ? 'dead_letter' : kind;
  }
}

/** Erinnerungen 7 und 12 Tage nach Einladung (idempotent über Schlüssel aus Fall, Ereignis, Regelversion, Stufe). */
async function scheduleReminders(c: PoolClient, m: OutboxRow, invitedAt: Date) {
  for (const r of reminderTimes(invitedAt, FOLLOWUP_PLAN_V1)) {
    const key = reminderIdempotencyKey({ caseId: m.case_id, eventId: m.assessment_event_id!, ruleVersion: m.rule_version, stage: `erinnerung-${r.stage}` });
    await c.query(
      `INSERT INTO outbox_message (idempotency_key, kind, center_id, patient_id, case_id, assessment_event_id, rule_version, stage, scheduled_at, next_attempt_at)
       VALUES ($1,'erinnerung',$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, m.center_id, m.patient_id, m.case_id, m.assessment_event_id, m.rule_version, `erinnerung-${r.stage}`, r.at],
    );
  }
}

export async function runOnce(deps: WorkerDeps): Promise<Record<string, number>> {
  const msgs = await claim(deps.pool);
  const stats: Record<string, number> = {};
  for (const m of msgs) {
    let r: string;
    try {
      r = await processMessage(deps, m);
    } catch (e) {
      r = 'fehler';
      await deps.pool.query(`UPDATE outbox_message SET status = 'unklar', last_error = $2, locked_until = NULL, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [m.id, (e as Error).message.slice(0, 200), backoffSeconds(m.attempts)]);
    }
    stats[r] = (stats[r] ?? 0) + 1;
  }
  return stats;
}
