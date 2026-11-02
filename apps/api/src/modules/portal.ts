import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PortalConsentSchema } from '@dart/contracts';
import { CONSENT_SCOPE_LABELS, CONSENT_STATUS_LABELS, ConsentStatus, consentAllows, displayStatus, EVENT_STATUS_LABELS, EventStatus, requiredScopesForCase } from '@dart/domain';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Public } from '../core/auth';
import { loadConfig, todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { ApiError, conflict, invalid, notFound, requestIdOf } from '../core/errors';
import { parse, rateLimit } from '../core/http';
import { VaultClient } from '../core/vault-client';
import { ConsentService, demoSignatureAdapter, sha256 } from './consent';
import { FollowUpService, loadCase, PLAN_REF } from './followup.service';
import { ResponsesService, Who } from './responses';

export const PORTAL_COOKIE = 'dart_portal';
const SESSION_MINUTES = 30;
const MAX_CODE_ATTEMPTS = 5;

interface PortalSession {
  id: string;
  patientId: string;
  centerId: string;
  verified: boolean;
}

@ApiTags('Patientenportal')
@Controller('api/v1/portal')
@Public()
export class PortalController {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly vault: VaultClient,
    private readonly consent: ConsentService,
    private readonly followup: FollowUpService,
    private readonly responses: ResponsesService,
  ) {}

  private async session(req: Request, requireVerified = true): Promise<PortalSession> {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[PORTAL_COOKIE];
    if (!raw) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Bitte öffnen Sie Ihren persönlichen Einladungslink.');
    const { rows } = await this.db.app.query('SELECT * FROM portal_find_session($1)', [sha256(raw)]);
    const s = rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Ihre Sitzung ist abgelaufen. Bitte öffnen Sie Ihren Einladungslink erneut oder fordern Sie einen neuen an.');
    if (requireVerified && !s.verified) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Bitte geben Sie zuerst Ihren persönlichen Zugangscode ein.');
    return { id: s.id, patientId: s.patient_id, centerId: s.center_id, verified: s.verified };
  }

  private scope(s: PortalSession) {
    return { centerIds: [s.centerId], patientId: s.patientId };
  }

  /**
   * Einlösen erst nach bewusster Bestätigung (POST aus der Seite, Token im URL-Fragment):
   * Mail-Linkscanner, die nur GET ausführen, verbrauchen den Token nicht (F14).
   */
  @Post('redeem')
  async redeem(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    rateLimit(req, 'portal-redeem', 20, 15 * 60_000);
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), body);
    const { rows } = await this.db.app.query('SELECT * FROM portal_find_invitation($1)', [sha256(token)]);
    const inv = rows[0];
    if (!inv) throw new ApiError(400, 'TOKEN_UNGUELTIG');
    if (inv.status !== 'aktiv') throw new ApiError(400, 'TOKEN_UNGUELTIG', inv.status === 'eingeloest' ? 'Dieser Link wurde bereits verwendet. Bitte fordern Sie bei Bedarf einen neuen Link an.' : undefined, undefined, { canResend: inv.purpose === 'befragung' && inv.status !== 'widerrufen' });
    if (new Date(inv.expires_at) < new Date()) {
      await this.db.tx({ centerIds: [inv.center_id] }, (c) => c.query(`UPDATE invitation SET status = 'abgelaufen' WHERE id = $1 AND status = 'aktiv'`, [inv.id]));
      throw new ApiError(400, 'TOKEN_UNGUELTIG', 'Dieser Link ist abgelaufen. Sie können einen neuen Link anfordern.', undefined, { canResend: inv.purpose === 'befragung' });
    }
    const sessionToken = randomBytes(32).toString('base64url');
    await this.db.tx({ centerIds: [inv.center_id], patientId: inv.patient_id }, async (c) => {
      const upd = await c.query(`UPDATE invitation SET status = 'eingeloest', redeemed_at = now() WHERE id = $1 AND status = 'aktiv' RETURNING id`, [inv.id]);
      if (!upd.rows.length) throw new ApiError(400, 'TOKEN_UNGUELTIG');
      await c.query(
        `INSERT INTO patient_session (session_hash, patient_id, center_id, invitation_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${SESSION_MINUTES} minutes')`,
        [sha256(sessionToken), inv.patient_id, inv.center_id, inv.id],
      );
      await this.audit.write(c, { kind: 'patient', patientId: inv.patient_id }, { action: 'einladung_einloesen', objectType: 'einladung', objectId: inv.id, centerId: inv.center_id, requestId: requestIdOf(req) });
    });
    res.cookie(PORTAL_COOKIE, sessionToken, { httpOnly: true, sameSite: 'strict', secure: loadConfig().cookieSecure, maxAge: SESSION_MINUTES * 60_000, path: '/' });
    return { ok: true, nextStep: 'zugangscode' };
  }

  /** Zweiter Faktor: persönlicher Zugangscode (Identität nicht allein über den E-Mail-Link). */
  @Post('verify')
  async verify(@Body() body: unknown, @Req() req: Request) {
    rateLimit(req, 'portal-verify', 20, 15 * 60_000);
    const s = await this.session(req, false);
    const { code } = parse(z.object({ code: z.string().trim().min(4).max(20) }), body);
    return this.db.tx(this.scope(s), async (c) => {
      const sess = (await c.query('SELECT verify_attempts FROM patient_session WHERE id = $1', [s.id])).rows[0];
      if (sess.verify_attempts >= MAX_CODE_ATTEMPTS) throw new ApiError(429, 'ZU_VIELE_VERSUCHE');
      const p = (await c.query('SELECT vault_ref FROM patient WHERE id = $1', [s.patientId])).rows[0];
      const ok = await this.vault.verifyAccessCode({ centerIds: [s.centerId], actor: `patient:${s.patientId}`, requestId: requestIdOf(req) }, p.vault_ref, code);
      if (!ok) {
        const n = (await c.query('UPDATE patient_session SET verify_attempts = verify_attempts + 1, revoked_at = CASE WHEN verify_attempts + 1 >= $2 THEN now() ELSE revoked_at END WHERE id = $1 RETURNING verify_attempts', [s.id, MAX_CODE_ATTEMPTS])).rows[0].verify_attempts;
        await this.audit.write(c, { kind: 'patient', patientId: s.patientId }, { action: 'zugangscode_pruefen', objectType: 'sitzung', objectId: s.id, centerId: s.centerId, result: 'abgelehnt', requestId: requestIdOf(req) });
        return { ok: false, remainingAttempts: Math.max(0, MAX_CODE_ATTEMPTS - n), message: n >= MAX_CODE_ATTEMPTS ? 'Zu viele Fehlversuche. Bitte wenden Sie sich an Ihr Zentrum.' : 'Der Zugangscode ist nicht korrekt.' };
      }
      await c.query('UPDATE patient_session SET verified = true WHERE id = $1', [s.id]);
      await this.audit.write(c, { kind: 'patient', patientId: s.patientId }, { action: 'portal_anmeldung', objectType: 'sitzung', objectId: s.id, centerId: s.centerId, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  /** Übersicht: Einwilligungsstatus (bei jedem Login geprüft) und eigene Befragungen. */
  @Get('me')
  async me(@Req() req: Request) {
    const s = await this.session(req);
    const today = todayBerlin();
    return this.db.tx(this.scope(s), async (c) => {
      const p = (await c.query('SELECT pseudonym FROM patient WHERE id = $1', [s.patientId])).rows[0];
      const consents = (await c.query(
        `SELECT cr.id, cr.status, cr.method, cr.scopes, cr.signed_date, cr.created_at, d.title, d.version, d.body, d.scopes AS document_scopes, d.is_demo
           FROM consent_record cr LEFT JOIN consent_document_version d ON d.id = cr.document_version_id
          WHERE cr.patient_id = $1 ORDER BY cr.created_at DESC`,
        [s.patientId],
      )).rows;
      const cases = (await c.query('SELECT id FROM treatment_case WHERE patient_id = $1 ORDER BY created_at', [s.patientId])).rows;
      const surveys: unknown[] = [];
      for (const cr of cases) {
        const cs = (await loadCase(c, cr.id))!;
        const gate = consentAllows(consents, requiredScopesForCase(cs.mode, cs.registers));
        const events = (await c.query(`SELECT id, timepoint, due_date, window_start, window_end, status FROM assessment_event WHERE case_id = $1 ORDER BY due_date`, [cs.id])).rows;
        const items = [];
        for (const e of events) {
          const st = displayStatus(e.status as EventStatus, e.window_end ?? '9999-12-31', today);
          const open = gate.ok && e.window_start <= today && e.window_end >= today && !['abgeschlossen', 'gesperrt', 'abgebrochen'].includes(e.status);
          let responseId: string | null = null;
          if (open) responseId = await this.followup.ensurePatientForm(c, cs, e.id, e.timepoint);
          items.push({ eventId: e.id, timepoint: e.timepoint, dueDate: e.due_date, windowStart: e.window_start, windowEnd: e.window_end, status: gate.ok ? st : 'gesperrt', statusLabel: EVENT_STATUS_LABELS[gate.ok ? st : 'gesperrt'], responseId, open });
        }
        surveys.push({ caseLabel: `${cs.joint === 'knie' ? 'Knie' : cs.joint} ${cs.side}`, consentOk: gate.ok, consentReason: gate.reason ?? null, events: items });
      }
      return {
        pseudonym: p.pseudonym,
        consents: consents.map((x) => ({
          id: x.id,
          status: x.status,
          statusLabel: CONSENT_STATUS_LABELS[x.status as ConsentStatus],
          method: x.method,
          scopes: x.scopes,
          signedDate: x.signed_date,
          document: x.status === 'signatur_ausstehend' || x.status === 'gueltig' ? { title: x.title, version: x.version, body: x.body, scopes: x.document_scopes.map((sc: string) => ({ code: sc, label: CONSENT_SCOPE_LABELS[sc as keyof typeof CONSENT_SCOPE_LABELS] })), isDemo: x.is_demo } : null,
        })),
        surveys,
      };
    });
  }

  /** Digitale Einwilligung (DEMONSTRATION, keine QES). Aktive Zustimmung, nichts vorangekreuzt. */
  @Post('consents/:id/sign')
  async sign(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const s = await this.session(req);
    const b = parse(PortalConsentSchema, body);
    const today = todayBerlin();
    if (b.signedDate !== today) throw invalid('Das Unterschriftsdatum muss dem heutigen Datum entsprechen.');
    const prep = await this.db.tx(this.scope(s), async (c) => {
      const cr = (await c.query(`SELECT cr.*, d.body, d.body_sha256, d.code AS doc_code, d.version AS doc_version, p.vault_ref, p.pseudonym FROM consent_record cr JOIN consent_document_version d ON d.id = cr.document_version_id JOIN patient p ON p.id = cr.patient_id WHERE cr.id = $1`, [id])).rows[0];
      if (!cr) throw notFound();
      if (cr.status !== 'signatur_ausstehend') throw conflict('ZUSTAND_UNZULAESSIG');
      const extra = b.acceptedScopes.filter((x) => !cr.scopes.includes(x));
      if (extra.length) throw invalid('Es kann nur dem angebotenen Umfang zugestimmt werden.');
      return cr;
    });
    const vctx = { centerIds: [s.centerId], actor: `patient:${s.patientId}`, requestId: requestIdOf(req) };
    // Ohne Zustimmung zur Registerteilnahme: Ablehnung dokumentieren, keine Signatur speichern
    if (!b.acceptedScopes.includes('register_basic')) {
      return this.db.tx(this.scope(s), async (c) => {
        await c.query(`UPDATE consent_record SET status = 'abgelehnt', rejection_reason = $2, revision = revision + 1 WHERE id = $1 AND status = 'signatur_ausstehend'`, [id, 'Teilnahme durch die Patientin/den Patienten nicht erteilt']);
        await this.audit.write(c, { kind: 'patient', patientId: s.patientId }, { action: 'einwilligung_abgelehnt', objectType: 'einwilligung', objectId: id, centerId: s.centerId, requestId: requestIdOf(req) });
        return { id, status: 'abgelehnt' };
      });
    }
    let signatureDoc: { documentId: string; sha256: string } | null = null;
    if (b.signature.kind === 'gezeichnet') {
      const stored = await this.vault.storeDocument(vctx, { vaultRef: prep.vault_ref, kind: 'signatur_demo', contentType: 'image/png', contentBase64: b.signature.pngDataUrl.replace(/^data:image\/png;base64,/, '') });
      if (stored.scanStatus !== 'sauber') throw new ApiError(422, 'UPLOAD_ABGELEHNT', `Unterschrift konnte nicht gespeichert werden: ${stored.detail}`);
      signatureDoc = stored;
    }
    const verification = demoSignatureAdapter.verify({ bodyText: prep.body, expectedSha256: prep.body_sha256, hasSignature: !!signatureDoc || b.signature.kind === 'getippt' });
    const signedAt = new Date();
    // Vollständiges Beweispaket (mit Informationstext und ggf. getipptem Namen) liegt im Vault
    const fullPackage = {
      typ: 'DART-Einwilligungsnachweis',
      schema: 1,
      hinweis: 'DEMONSTRATION – keine qualifizierte elektronische Signatur; Produktionsniveau ist mit Datenschutz/Ethik festzulegen.',
      verfahren: 'digital_demo',
      dokumentversion: { code: prep.doc_code, version: prep.doc_version, informationstext_sha256: prep.body_sha256 },
      informationstext: prep.body,
      angebotener_umfang: prep.scopes,
      zugestimmter_umfang: b.acceptedScopes,
      pseudonym: prep.pseudonym,
      signaturverfahren: b.signature.kind === 'gezeichnet' ? 'Gezeichnete Unterschrift (Demonstration, ohne biometrische Dynamikdaten)' : 'Getippter Name (barrierefreie Alternative, Demonstration)',
      getippter_name: b.signature.kind === 'getippt' ? b.signature.typedName : undefined,
      signaturbild_sha256: signatureDoc?.sha256,
      unterschriftsdatum: b.signedDate,
      zeitpunkt_utc: signedAt.toISOString(),
      pruefung: { adapter: demoSignatureAdapter.id, ergebnis: verification.ok ? 'bestanden' : 'nicht bestanden', detail: verification.detail },
    };
    const pkgDoc = await this.vault.storeDocument(vctx, { vaultRef: prep.vault_ref, kind: 'einwilligung_kopie', contentType: 'application/json', contentBase64: Buffer.from(JSON.stringify(fullPackage)).toString('base64') });
    return this.db.tx(this.scope(s), async (c) => {
      if (!verification.ok) {
        await c.query(`UPDATE consent_record SET status = 'abgelehnt', rejection_reason = $2, revision = revision + 1 WHERE id = $1`, [id, verification.detail]);
        return { id, status: 'abgelehnt', detail: verification.detail };
      }
      const corePackage = { ...fullPackage, informationstext: undefined, getippter_name: undefined, pseudonym: undefined, nachweis_dokument: pkgDoc.documentId };
      const upd = await c.query(
        `UPDATE consent_record SET status = 'gueltig', scopes = $2, signed_date = $3, reviewed_at = $4, evidence_ref = $5, evidence_sha256 = $6, evidence_package = $7, revision = revision + 1
          WHERE id = $1 AND status = 'signatur_ausstehend' RETURNING id`,
        [id, b.acceptedScopes, b.signedDate, signedAt, pkgDoc.documentId, pkgDoc.sha256, JSON.stringify(corePackage)],
      );
      if (!upd.rows.length) throw conflict('KONFLIKT');
      await this.audit.write(c, { kind: 'patient', patientId: s.patientId }, { action: 'einwilligung_digital_demo', objectType: 'einwilligung', objectId: id, centerId: s.centerId, requestId: requestIdOf(req) });
      await this.consent.activatePatientCases(c, s.patientId, { kind: 'patient', patientId: s.patientId }, requestIdOf(req));
      return { id, status: 'gueltig' };
    });
  }

  /** Abrufbare Kopie der eigenen Einwilligung (Beweispaket aus dem Vault). */
  @Get('consents/:id/copy')
  async copy(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const s = await this.session(req);
    const cr = await this.db.tx(this.scope(s), async (c) => {
      const row = (await c.query('SELECT id, evidence_ref, method, evidence_package, status FROM consent_record WHERE id = $1', [id])).rows[0];
      if (!row) throw notFound();
      await this.audit.write(c, { kind: 'patient', patientId: s.patientId }, { action: 'einwilligung_kopie', objectType: 'einwilligung', objectId: id, centerId: s.centerId, requestId: requestIdOf(req) });
      return row;
    });
    if (cr.method === 'digital_demo' && cr.evidence_ref) {
      const d = await this.vault.getDocument({ centerIds: [s.centerId], actor: `patient:${s.patientId}`, requestId: requestIdOf(req) }, cr.evidence_ref);
      return { status: cr.status, nachweis: JSON.parse(Buffer.from(d.contentBase64, 'base64').toString('utf8')) };
    }
    return { status: cr.status, nachweis: cr.evidence_package };
  }

  @Post('consents/:id/withdraw')
  async withdraw(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const s = await this.session(req);
    const { confirm } = parse(z.object({ confirm: z.literal(true, { message: 'Bitte bestätigen Sie den Widerruf' }) }), body);
    void confirm;
    return this.db.tx(this.scope(s), (c) => this.consent.withdraw(c, id, { kind: 'patient', patientId: s.patientId }, 'portal', null, requestIdOf(req)));
  }

  @Get('responses/:id')
  async getResponse(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const s = await this.session(req);
    return this.responses.get(id, this.who(s), req);
  }

  @Patch('responses/:id/draft')
  async draft(@Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch: string, @Body() body: unknown, @Req() req: Request) {
    const s = await this.session(req);
    return this.responses.saveDraft(id, ifMatch, body, this.who(s), req);
  }

  @Post('responses/:id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch: string, @Req() req: Request) {
    const s = await this.session(req);
    return this.responses.submit(id, ifMatch, this.who(s), req);
  }

  /** Neuer Link bei Ablauf: nur bei gültiger Einwilligung, über die Outbox (kein direkter Versand). */
  @Post('resend')
  async resend(@Body() body: unknown, @Req() req: Request) {
    rateLimit(req, 'portal-resend', 5, 60 * 60_000);
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), body);
    const { rows } = await this.db.app.query('SELECT * FROM portal_find_invitation($1)', [sha256(token)]);
    const inv = rows[0];
    // Keine Aussage darüber, ob der Token existiert
    const neutral = { ok: true, message: 'Falls Ihr Link gültig zugeordnet werden kann, erhalten Sie in Kürze eine neue E-Mail.' };
    if (!inv || inv.purpose !== 'befragung' || !inv.case_id || !inv.assessment_event_id || inv.status === 'widerrufen') return neutral;
    await this.db.tx({ centerIds: [inv.center_id], patientId: inv.patient_id }, async (c: Tx) => {
      const cs = await loadCase(c, inv.case_id);
      if (!cs) return;
      const n = (await c.query(`SELECT count(*)::int AS n FROM outbox_message WHERE assessment_event_id = $1 AND stage LIKE 'erneut-%'`, [inv.assessment_event_id])).rows[0].n;
      if (n >= 3) return;
      await c.query(
        `INSERT INTO outbox_message (idempotency_key, kind, center_id, patient_id, case_id, assessment_event_id, rule_version, stage, scheduled_at)
         VALUES ($1,'einladung',$2,$3,$4,$5,$6,$7, now()) ON CONFLICT DO NOTHING`,
        [`${cs.id}:${inv.assessment_event_id}:${PLAN_REF}:erneut-${n + 1}`, cs.center_id, cs.patient_id, cs.id, inv.assessment_event_id, PLAN_REF, `erneut-${n + 1}`],
      );
    });
    return neutral;
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const s = await this.session(req, false);
      await this.db.tx(this.scope(s), (c) => c.query('UPDATE patient_session SET revoked_at = now() WHERE id = $1', [s.id]));
    } catch {
      /* bereits abgemeldet */
    }
    res.clearCookie(PORTAL_COOKIE, { path: '/' });
    return { ok: true };
  }

  private who(s: PortalSession): Who {
    return { kind: 'patient', patientId: s.patientId, centerId: s.centerId };
  }
}
