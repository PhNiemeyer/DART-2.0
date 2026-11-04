import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm } from '../core/auth';
import { Db, Tx } from '../core/db';
import { conflict, forbidden, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';

/** Problemfälle, die eine Bearbeitung brauchen. */
export const PROBLEM_STATUS = ['dead_letter', 'unklar', 'fehlgeschlagen'] as const;
const STATUS = ['ausstehend', 'in_versand', 'versendet', 'unklar', 'fehlgeschlagen', 'dead_letter', 'storniert'] as const;
const REQUEUE_FROM = ['dead_letter', 'fehlgeschlagen', 'storniert'];
const CANCEL_FROM = ['ausstehend', 'fehlgeschlagen', 'unklar', 'dead_letter'];
const Reason = z.string().trim().min(3, 'Bitte einen Grund angeben (mind. 3 Zeichen)').max(300);

/** Kontaktstatus des E-Mail-Kanals; ohne Eintrag „aktiv“. */
export async function emailStatus(c: Tx, patientId: string): Promise<{ status: 'aktiv' | 'abgemeldet' | 'unzustellbar'; source: string | null; reason: string | null; updatedAt: string | null }> {
  const r = (await c.query('SELECT email_status, source, reason, updated_at FROM contact_preference WHERE patient_id = $1', [patientId])).rows[0];
  return r ? { status: r.email_status, source: r.source, reason: r.reason, updatedAt: r.updated_at } : { status: 'aktiv', source: null, reason: null, updatedAt: null };
}

export async function setEmailStatus(c: Tx, p: { patientId: string; centerId: string; status: 'aktiv' | 'abgemeldet' | 'unzustellbar'; source: 'portal' | 'zentrum' | 'versand'; reason: string | null; userId: string | null }) {
  await c.query(
    `INSERT INTO contact_preference (patient_id, center_id, email_status, source, reason, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (patient_id) DO UPDATE SET email_status = EXCLUDED.email_status, source = EXCLUDED.source, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [p.patientId, p.centerId, p.status, p.source, p.reason, p.userId],
  );
}

/**
 * Versand-Leitstand (R-14): Versandjournal, Dead Letters, unklare Zustellungen, Abmeldungen.
 * Bearbeitung nur im eigenen Zentrum (RLS); die zentrale Administration sieht nur Anzahlen ohne Patientenbezug.
 * Keine E-Mail-Adressen und keine Inhalte im Leitstand; Adressen bleiben im Vault.
 */
@ApiTags('Versand')
@Controller('api/v1/dispatch')
export class DispatchController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  private scope(actor: Actor, centerId?: string): string[] {
    const centers = centersWith(actor, 'dispatch.manage');
    if (centerId && !centers.includes(centerId)) throw notFound();
    return centerId ? [centerId] : centers;
  }

  @Get('summary')
  async summary(@CurrentActor() actor: Actor, @Query() query: Record<string, string>) {
    const q = parse(z.object({ centerId: z.string().uuid().optional() }), query);
    if (can(actor, 'dispatch.manage')) {
      return this.db.tx({ centerIds: this.scope(actor, q.centerId) }, async (c) => {
        const byStatus = (await c.query(`SELECT status, count(*)::int AS n FROM outbox_message WHERE kind <> 'export' GROUP BY status`)).rows;
        const contacts = (await c.query(`SELECT email_status AS status, count(*)::int AS n FROM contact_preference WHERE email_status <> 'aktiv' GROUP BY email_status`)).rows;
        return { ebene: 'zentrum', byStatus, contacts, problems: byStatus.filter((r) => (PROBLEM_STATUS as readonly string[]).includes(r.status)).reduce((a, r) => a + r.n, 0) };
      });
    }
    if (can(actor, 'dispatch.overview')) {
      const rows = (await this.db.app.query('SELECT * FROM dispatch_overview()')).rows;
      return { ebene: 'zentral', byCenter: rows, hinweis: 'Nur Anzahlen je Zentrum; Bearbeitung erfolgt im jeweiligen Zentrum.' };
    }
    throw forbidden();
  }

  @Get()
  @Perm('dispatch.manage')
  async list(@CurrentActor() actor: Actor, @Query() query: Record<string, string>, @Req() req: Request) {
    const q = parse(
      z.object({
        status: z.enum(['probleme', 'alle', ...STATUS]).default('probleme'),
        kind: z.enum(['einladung', 'erinnerung', 'arzt_erinnerung', 'vor_ort_link']).optional(),
        centerId: z.string().uuid().optional(),
        caseId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).max(1000).default(1),
      }),
      query,
    );
    const size = 50;
    return this.db.tx({ centerIds: this.scope(actor, q.centerId) }, async (c) => {
      const where = `o.kind <> 'export'
        AND ($1 = 'alle' OR ($1 = 'probleme' AND o.status = ANY ($2::text[])) OR o.status = $1)
        AND ($3::text IS NULL OR o.kind = $3) AND ($4::uuid IS NULL OR o.case_id = $4)`;
      const args = [q.status, PROBLEM_STATUS, q.kind ?? null, q.caseId ?? null];
      const total = (await c.query(`SELECT count(*)::int AS n FROM outbox_message o WHERE ${where}`, args)).rows[0].n;
      const items = (await c.query(
        `SELECT o.id, o.kind, o.stage, o.status, o.attempts, o.max_attempts, o.scheduled_at, o.next_attempt_at, o.updated_at, o.last_error, o.cancel_reason,
                o.handling_note, o.handled_at, o.case_id, tc.case_no, p.pseudonym, ae.timepoint, c.code AS center_code,
                COALESCE(cp.email_status, 'aktiv') AS email_status
           FROM outbox_message o
           JOIN center c ON c.id = o.center_id
           LEFT JOIN treatment_case tc ON tc.id = o.case_id
           LEFT JOIN patient p ON p.id = o.patient_id
           LEFT JOIN assessment_event ae ON ae.id = o.assessment_event_id
           LEFT JOIN contact_preference cp ON cp.patient_id = o.patient_id
          WHERE ${where}
          ORDER BY CASE o.status WHEN 'dead_letter' THEN 0 WHEN 'unklar' THEN 1 WHEN 'fehlgeschlagen' THEN 2 ELSE 3 END, o.updated_at DESC
          LIMIT ${size} OFFSET ${(q.page - 1) * size}`,
        args,
      )).rows;
      await this.audit.write(c, actor, { action: 'versandjournal_lesen', objectType: 'versand', objectId: q.status, requestId: requestIdOf(req) });
      return { total, page: q.page, pageSize: size, items };
    });
  }

  @Get(':id')
  @Perm('dispatch.manage')
  async detail(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx({ centerIds: this.scope(actor) }, async (c) => {
      const m = (await c.query(
        `SELECT o.id, o.kind, o.stage, o.status, o.attempts, o.max_attempts, o.scheduled_at, o.next_attempt_at, o.created_at, o.updated_at, o.last_error,
                o.cancel_reason, o.handling_note, o.handled_at, (o.provider_message_id IS NOT NULL) AS has_provider_id, o.case_id, o.patient_id, tc.case_no, p.pseudonym, ae.timepoint
           FROM outbox_message o LEFT JOIN treatment_case tc ON tc.id = o.case_id LEFT JOIN patient p ON p.id = o.patient_id
           LEFT JOIN assessment_event ae ON ae.id = o.assessment_event_id WHERE o.id = $1 AND o.kind <> 'export'`,
        [id],
      )).rows[0];
      if (!m) throw notFound();
      const journal = (await c.query(`SELECT attempt_no, started_at, finished_at, result, error_code FROM delivery_attempt WHERE outbox_id = $1 ORDER BY attempt_no`, [id])).rows;
      const contact = m.patient_id && m.kind !== 'arzt_erinnerung' ? await emailStatus(c, m.patient_id) : null;
      const { patient_id: _p, ...rest } = m;
      void _p;
      return { ...rest, journal, contact, actions: this.actions(m.status, contact?.status ?? 'aktiv') };
    });
  }

  private actions(status: string, contact: string) {
    return {
      requeue: REQUEUE_FROM.includes(status) && contact === 'aktiv',
      cancel: CANCEL_FROM.includes(status),
      reconcile: status === 'unklar',
    };
  }

  private async load(c: Tx, id: string) {
    const m = (await c.query(`SELECT id, status, attempts, max_attempts, center_id, patient_id, kind FROM outbox_message WHERE id = $1 AND kind <> 'export' FOR UPDATE`, [id])).rows[0];
    if (!m) throw notFound();
    return m;
  }

  /** Erneut einreihen: gleiche Nachricht (Idempotenzschlüssel bleibt), Versuchsbudget +5; Einwilligung wird vor Versand erneut geprüft. */
  @Post(':id/requeue')
  @Perm('dispatch.manage')
  async requeue(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: Reason }), body);
    return this.db.tx({ centerIds: this.scope(actor) }, async (c) => {
      const m = await this.load(c, id);
      if (!REQUEUE_FROM.includes(m.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Nur fehlgeschlagene, stornierte oder Dead-Letter-Nachrichten können erneut eingereiht werden.');
      if (m.patient_id && m.kind !== 'arzt_erinnerung') {
        const cs = await emailStatus(c, m.patient_id);
        if (cs.status !== 'aktiv') throw conflict('ZUSTAND_UNZULAESSIG', cs.status === 'abgemeldet' ? 'Die Person hat E-Mail-Erinnerungen abbestellt.' : 'Die E-Mail-Adresse ist als unzustellbar markiert. Bitte zuerst Adresse prüfen und Kontakt wieder aktivieren.');
      }
      await c.query(
        `UPDATE outbox_message SET status = 'ausstehend', max_attempts = LEAST(attempts + 5, 50), next_attempt_at = now(), cancel_reason = NULL, locked_until = NULL,
                handled_by = $2, handled_at = now(), handling_note = $3, updated_at = now() WHERE id = $1`,
        [id, actor.userId, reason],
      );
      await this.audit.write(c, actor, { action: 'versand_erneut_einreihen', objectType: 'versand', objectId: id, centerId: m.center_id, reason, requestId: requestIdOf(req) });
      return { id, status: 'ausstehend' };
    });
  }

  @Post(':id/cancel')
  @Perm('dispatch.manage')
  async cancel(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: Reason }), body);
    return this.db.tx({ centerIds: this.scope(actor) }, async (c) => {
      const m = await this.load(c, id);
      if (!CANCEL_FROM.includes(m.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Diese Nachricht kann im aktuellen Zustand nicht storniert werden.');
      await c.query(
        `UPDATE outbox_message SET status = 'storniert', cancel_reason = $3, handled_by = $2, handled_at = now(), handling_note = $3, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id, actor.userId, `Manuell: ${reason}`.slice(0, 300)],
      );
      await this.audit.write(c, actor, { action: 'versand_stornieren', objectType: 'versand', objectId: id, centerId: m.center_id, reason, requestId: requestIdOf(req) });
      return { id, status: 'storniert' };
    });
  }

  /** Abgleich anstoßen: Der Worker fragt beim Anbieter nach der Message-ID, bevor er erneut sendet (nie blind doppelt). */
  @Post(':id/reconcile')
  @Perm('dispatch.manage')
  async reconcile(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.db.tx({ centerIds: this.scope(actor) }, async (c) => {
      const m = await this.load(c, id);
      if (m.status !== 'unklar') throw conflict('ZUSTAND_UNZULAESSIG', 'Ein Abgleich ist nur bei unklarer Zustellung möglich.');
      await c.query(`UPDATE outbox_message SET next_attempt_at = now(), max_attempts = GREATEST(max_attempts, attempts + 1), handled_by = $2, handled_at = now(), handling_note = 'Abgleich angefordert', updated_at = now() WHERE id = $1`, [id, actor.userId]);
      await this.audit.write(c, actor, { action: 'versand_abgleich_anfordern', objectType: 'versand', objectId: id, centerId: m.center_id, requestId: requestIdOf(req) });
      return { id, status: 'unklar', abgleich: 'angefordert' };
    });
  }
}

/** Kontaktstatus (E-Mail) am Fall: Abmeldung durch das Zentrum, z. B. nach Telefonat; Reaktivierung nach Adressprüfung. */
@ApiTags('Versand')
@Controller('api/v1/cases/:caseId/contact-preference')
export class ContactPreferenceController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  @Get()
  @Perm('case.read')
  async get(@CurrentActor() actor: Actor, @Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.db.tx({ centerIds: centersWith(actor, 'case.read') }, async (c) => {
      const tc = (await c.query('SELECT patient_id FROM treatment_case WHERE id = $1', [caseId])).rows[0];
      if (!tc) throw notFound();
      return { ...(await emailStatus(c, tc.patient_id)), canEdit: can(actor, 'dispatch.manage') };
    });
  }

  @Put()
  @Perm('dispatch.manage')
  async put(@CurrentActor() actor: Actor, @Param('caseId', ParseUUIDPipe) caseId: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(
      z.object({ emailStatus: z.enum(['aktiv', 'abgemeldet']), reason: Reason, addressChecked: z.boolean().optional() }),
      body,
    );
    return this.db.tx({ centerIds: centersWith(actor, 'dispatch.manage') }, async (c) => {
      const tc = (await c.query('SELECT patient_id, center_id FROM treatment_case WHERE id = $1', [caseId])).rows[0];
      if (!tc) throw notFound();
      const cur = await emailStatus(c, tc.patient_id);
      if (cur.status === 'unzustellbar' && b.emailStatus === 'aktiv' && !b.addressChecked) {
        throw conflict('ZUSTAND_UNZULAESSIG', 'Die Adresse war unzustellbar. Bitte bestätigen Sie, dass die E-Mail-Adresse geprüft bzw. korrigiert wurde.');
      }
      await setEmailStatus(c, { patientId: tc.patient_id, centerId: tc.center_id, status: b.emailStatus, source: 'zentrum', reason: b.reason, userId: actor.userId });
      await this.audit.write(c, actor, { action: b.emailStatus === 'abgemeldet' ? 'email_abmeldung_zentrum' : 'email_reaktivierung', objectType: 'kontakt', objectId: tc.patient_id, centerId: tc.center_id, reason: b.reason, requestId: requestIdOf(req) });
      return emailStatus(c, tc.patient_id);
    });
  }
}
