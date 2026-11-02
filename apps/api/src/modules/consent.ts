import { Body, Controller, Get, Injectable, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConsentPrepareSchema, PaperReviewSchema } from '@dart/contracts';
import { canTransition, checklistComplete, ConsentStatus } from '@dart/domain';
import { createHash, randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Audit, AuditActor } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm, readableCenters } from '../core/auth';
import { loadConfig, todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { ApiError, conflict, invalid, notFound, requestIdOf } from '../core/errors';
import { Idempotency, parse } from '../core/http';
import { VaultClient } from '../core/vault-client';
import { FollowUpService } from './followup.service';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * Austauschbarer Signaturadapter (F12). Im Prototyp ausschließlich DEMONSTRATION:
 * prüft technisch Dokumenthash und Vorliegen einer Unterschrift – KEINE qualifizierte elektronische Signatur.
 */
export interface SignatureAdapter {
  id: string;
  label: string;
  verify(p: { bodyText: string; expectedSha256: string; hasSignature: boolean }): { ok: boolean; detail: string };
}

export const demoSignatureAdapter: SignatureAdapter = {
  id: 'demo-signatur-v1',
  label: 'Demonstrations-Signaturadapter (keine QES, keine fortgeschrittene Signatur)',
  verify({ bodyText, expectedSha256, hasSignature }) {
    if (sha256(bodyText) !== expectedSha256) return { ok: false, detail: 'Informationstext stimmt nicht mit der Dokumentversion überein' };
    if (!hasSignature) return { ok: false, detail: 'Keine Unterschrift vorhanden' };
    return { ok: true, detail: 'Technisch geprüft: Dokumenthash stimmt, Unterschrift vorhanden (Demonstration)' };
  },
};

async function setStatus(c: Tx, id: string, from: ConsentStatus, to: ConsentStatus, extra: Record<string, unknown> = {}) {
  if (!canTransition(from, to)) throw conflict('ZUSTAND_UNZULAESSIG', `Übergang „${from}“ → „${to}“ ist nicht zulässig.`);
  const sets = ['status = $2', 'revision = revision + 1'];
  const args: unknown[] = [id, to];
  for (const [k, v] of Object.entries(extra)) {
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  args.push(from);
  const r = await c.query(`UPDATE consent_record SET ${sets.join(', ')} WHERE id = $1 AND status = $${args.length} RETURNING revision`, args);
  if (!r.rows.length) throw conflict('KONFLIKT');
}

@Injectable()
export class ConsentService {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly vault: VaultClient, private readonly followup: FollowUpService) {}

  async activatePatientCases(c: Tx, patientId: string, actor: AuditActor, requestId?: string) {
    const { rows } = await c.query('SELECT id FROM treatment_case WHERE patient_id = $1', [patientId]);
    for (const r of rows) await this.followup.activateIfConsented(c, r.id, actor, requestId);
  }

  /** Vor-Ort-Einladung: einmaliger Token (nur gehasht gespeichert) + persönlicher Zugangscode aus dem Vault. */
  async createOnsiteInvitation(c: Tx, patient: { id: string; center_id: string; vault_ref: string }, actor: Actor, requestId: string) {
    const t = newToken();
    await c.query(
      `UPDATE invitation SET status = 'widerrufen', revoked_at = now() WHERE patient_id = $1 AND purpose = 'vor_ort' AND status = 'aktiv'`,
      [patient.id],
    );
    await c.query(
      `INSERT INTO invitation (center_id, patient_id, purpose, token_hash, expires_at) VALUES ($1,$2,'vor_ort',$3, now() + interval '2 hours')`,
      [patient.center_id, patient.id, t.hash],
    );
    const accessCode = await this.vault.newAccessCode({ centerIds: [patient.center_id], actor: actor.userId, requestId }, patient.vault_ref);
    await this.audit.write(c, actor, { action: 'vor_ort_einladung', objectType: 'patient', objectId: patient.id, centerId: patient.center_id, requestId });
    return { portalLink: `${loadConfig().publicWebUrl}/portal/einladung#t=${t.token}`, token: t.token, accessCode, expiresInMinutes: 120 };
  }

  async prepare(actor: Actor, body: unknown, req: Request) {
    const b = parse(ConsentPrepareSchema, body);
    if (!b.scopes.includes('register_basic')) throw invalid('Der Umfang „Teilnahme am Register“ ist für jede Einwilligung erforderlich.');
    return this.db.tx({ centerIds: centersWith(actor, 'consent.manage') }, async (c) => {
      const p = (await c.query('SELECT id, center_id, vault_ref FROM patient WHERE id = $1', [b.patientId])).rows[0];
      if (!p || !can(actor, 'consent.manage', p.center_id)) throw notFound();
      const doc = (await c.query('SELECT id, scopes, active FROM consent_document_version WHERE id = $1', [b.documentVersionId])).rows[0];
      if (!doc || !doc.active) throw invalid('Unbekannte oder inaktive Dokumentversion');
      const extra = b.scopes.filter((s) => !doc.scopes.includes(s));
      if (extra.length) throw invalid(`Umfang nicht in dieser Dokumentversion enthalten: ${extra.join(', ')}`);
      const open = await c.query(`SELECT id FROM consent_record WHERE patient_id = $1 AND status IN ('vorbereitet','signatur_ausstehend','upload_in_pruefung')`, [b.patientId]);
      if (open.rows.length) throw conflict('ZUSTAND_UNZULAESSIG', 'Für diese Person läuft bereits ein Einwilligungsvorgang.');
      const ins = await c.query(
        `INSERT INTO consent_record (center_id, patient_id, document_version_id, status, method, scopes, informed_by, created_by)
         VALUES ($1,$2,$3,'vorbereitet',$4,$5,$6,$7) RETURNING id`,
        [p.center_id, p.id, doc.id, b.method, b.scopes, b.informedBy ?? null, actor.userId],
      );
      const id = ins.rows[0].id as string;
      await this.audit.write(c, actor, { action: 'einwilligung_vorbereiten', objectType: 'einwilligung', objectId: id, centerId: p.center_id, requestId: requestIdOf(req) });
      let onsite: Awaited<ReturnType<ConsentService['createOnsiteInvitation']>> | null = null;
      if (b.method === 'digital_demo') {
        await setStatus(c, id, 'vorbereitet', 'signatur_ausstehend');
        onsite = await this.createOnsiteInvitation(c, p, actor, requestIdOf(req));
      }
      return { id, status: b.method === 'digital_demo' ? 'signatur_ausstehend' : 'vorbereitet', onsite };
    });
  }

  async newOnsiteLink(actor: Actor, id: string, req: Request) {
    return this.db.tx({ centerIds: centersWith(actor, 'consent.manage') }, async (c) => {
      const cr = (await c.query('SELECT cr.status, p.id, p.center_id, p.vault_ref FROM consent_record cr JOIN patient p ON p.id = cr.patient_id WHERE cr.id = $1', [id])).rows[0];
      if (!cr || !can(actor, 'consent.manage', cr.center_id)) throw notFound();
      if (cr.status !== 'signatur_ausstehend') throw conflict('ZUSTAND_UNZULAESSIG');
      return this.createOnsiteInvitation(c, cr, actor, requestIdOf(req));
    });
  }

  /** Papierweg: Upload durch berechtigtes Personal → Prüfung (MIME/Magic Bytes, Malware) → „Upload in Prüfung“. */
  async uploadEvidence(actor: Actor, id: string, body: unknown, req: Request) {
    const b = parse(z.object({ fileName: z.string().max(200), contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']), contentBase64: z.string().min(1) }), body);
    const centers = centersWith(actor, 'consent.manage');
    const cr = await this.db.tx({ centerIds: centers }, async (c) => {
      const row = (await c.query('SELECT cr.id, cr.status, cr.method, cr.center_id, p.vault_ref FROM consent_record cr JOIN patient p ON p.id = cr.patient_id WHERE cr.id = $1', [id])).rows[0];
      if (!row || !can(actor, 'consent.manage', row.center_id)) throw notFound();
      if (row.method !== 'papier_upload') throw conflict('ZUSTAND_UNZULAESSIG', 'Dieser Vorgang ist für die digitale Signatur angelegt.');
      if (!['vorbereitet', 'abgelehnt'].includes(row.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Upload ist nur für vorbereitete oder abgelehnte Nachweise möglich.');
      return row;
    });
    const stored = await this.vault.storeDocument(
      { centerIds: [cr.center_id], actor: actor.userId, requestId: requestIdOf(req) },
      { vaultRef: cr.vault_ref, kind: 'einwilligung_papier', originalName: b.fileName.slice(0, 200), contentType: b.contentType, contentBase64: b.contentBase64 },
    );
    return this.db.tx({ centerIds: centers }, async (c) => {
      if (stored.scanStatus !== 'sauber') {
        await this.audit.write(c, actor, { action: 'nachweis_upload', objectType: 'einwilligung', objectId: id, centerId: cr.center_id, result: 'abgelehnt', reason: stored.detail, requestId: requestIdOf(req) });
        throw new ApiError(422, 'UPLOAD_ABGELEHNT', `Die Datei wurde abgelehnt: ${stored.detail}`);
      }
      if (cr.status === 'abgelehnt') await setStatus(c, id, 'abgelehnt', 'vorbereitet');
      await setStatus(c, id, 'vorbereitet', 'upload_in_pruefung', {
        uploaded_at: new Date(),
        evidence_ref: stored.documentId,
        evidence_sha256: stored.sha256,
        rejection_reason: null,
      });
      await this.audit.write(c, actor, { action: 'nachweis_upload', objectType: 'einwilligung', objectId: id, centerId: cr.center_id, requestId: requestIdOf(req) });
      return { id, status: 'upload_in_pruefung', sha256: stored.sha256, scan: stored.detail };
    });
  }

  /** Sichtprüfung: richtige Person, Vollständigkeit, Version, Unterschrift. Erst danach „gültig“. */
  async review(actor: Actor, id: string, body: unknown, req: Request) {
    const b = parse(PaperReviewSchema, body);
    return this.db.tx({ centerIds: centersWith(actor, 'consent.review') }, async (c) => {
      const cr = (await c.query('SELECT * FROM consent_record WHERE id = $1', [id])).rows[0];
      if (!cr || !can(actor, 'consent.review', cr.center_id)) throw notFound();
      if (cr.status !== 'upload_in_pruefung') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur Nachweise in Prüfung können entschieden werden.');
      if (b.decision === 'gueltig') {
        if (!checklistComplete(b.checklist)) throw invalid('Alle Prüfpunkte müssen bestätigt sein, um den Nachweis als gültig zu markieren.');
        if (!b.signedDate) throw invalid('Bitte das Unterschriftsdatum laut Dokument angeben.');
        if (b.signedDate > todayBerlin()) throw invalid('Das Unterschriftsdatum darf nicht in der Zukunft liegen.');
        const doc = (await c.query('SELECT code, version, body_sha256 FROM consent_document_version WHERE id = $1', [cr.document_version_id])).rows[0];
        const reviewedAt = new Date();
        const pkg = {
          typ: 'DART-Einwilligungsnachweis',
          schema: 1,
          verfahren: 'papier_upload',
          dokumentversion: { code: doc.code, version: doc.version, informationstext_sha256: doc.body_sha256 },
          umfang: cr.scopes,
          nachweis_dokument_sha256: cr.evidence_sha256,
          unterschriftsdatum: b.signedDate,
          uploadzeit_utc: cr.uploaded_at,
          pruefzeit_utc: reviewedAt.toISOString(),
          pruefer: actor.userId,
          pruefliste: b.checklist,
        };
        await setStatus(c, id, 'upload_in_pruefung', 'gueltig', {
          reviewed_at: reviewedAt,
          reviewed_by: actor.userId,
          review_checklist: JSON.stringify(b.checklist),
          signed_date: b.signedDate,
          evidence_package: JSON.stringify(pkg),
        });
        await this.audit.write(c, actor, { action: 'nachweis_pruefen_gueltig', objectType: 'einwilligung', objectId: id, centerId: cr.center_id, requestId: requestIdOf(req) });
        await this.activatePatientCases(c, cr.patient_id, actor, requestIdOf(req));
        return { id, status: 'gueltig' };
      }
      if (!b.rejectionReason || b.rejectionReason.length < 5) throw invalid('Bitte einen Ablehnungsgrund angeben.');
      await setStatus(c, id, 'upload_in_pruefung', 'abgelehnt', { reviewed_at: new Date(), reviewed_by: actor.userId, review_checklist: JSON.stringify(b.checklist), rejection_reason: b.rejectionReason });
      await this.audit.write(c, actor, { action: 'nachweis_pruefen_abgelehnt', objectType: 'einwilligung', objectId: id, centerId: cr.center_id, reason: b.rejectionReason, requestId: requestIdOf(req) });
      return { id, status: 'abgelehnt' };
    });
  }

  /** Widerruf: sofort Forschungsfreigabe und Befragungen sperren, Tokens/Versand widerrufen (F15). */
  async withdraw(c: Tx, consentId: string, actor: AuditActor, channel: 'portal' | 'personal' | 'schriftlich', note: string | null, requestId: string) {
    const cr = (await c.query('SELECT id, status, center_id, patient_id FROM consent_record WHERE id = $1', [consentId])).rows[0];
    if (!cr) throw notFound();
    if (!['gueltig', 'erneuerung_erforderlich', 'historisch_ungeklaert'].includes(cr.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Diese Einwilligung kann nicht widerrufen werden.');
    await setStatus(c, consentId, cr.status, 'widerrufen');
    await c.query('INSERT INTO withdrawal_event (consent_id, center_id, channel, recorded_by, note) VALUES ($1,$2,$3,$4,$5)', [consentId, cr.center_id, channel, actor.kind === 'nutzer' ? actor.userId : null, note]);
    await this.followup.blockPatient(c, cr.patient_id, 'Einwilligung widerrufen');
    await this.audit.write(c, actor, { action: 'einwilligung_widerrufen', objectType: 'einwilligung', objectId: consentId, centerId: cr.center_id, requestId });
    return { id: consentId, status: 'widerrufen', hinweis: 'Weitere Befragungen und Versand sind gesperrt. Der Umgang mit bereits erhobenen Daten folgt dem freigegebenen Rechtskonzept (offene Entscheidung E-07).' };
  }

  async evidenceFile(actor: Actor, id: string, req: Request) {
    const cr = await this.db.tx({ centerIds: centersWith(actor, 'consent.review') }, async (c) => {
      const row = (await c.query('SELECT id, center_id, evidence_ref, method FROM consent_record WHERE id = $1', [id])).rows[0];
      if (!row || !can(actor, 'consent.review', row.center_id) || !row.evidence_ref) throw notFound();
      await this.audit.write(c, actor, { action: 'nachweis_download', objectType: 'einwilligung', objectId: id, centerId: row.center_id, requestId: requestIdOf(req) });
      return row;
    });
    return this.vault.getDocument({ centerIds: [cr.center_id], actor: actor.userId, requestId: requestIdOf(req) }, cr.evidence_ref);
  }
}

@ApiTags('Einwilligung')
@Controller('api/v1/consents')
export class ConsentController {
  constructor(private readonly svc: ConsentService, private readonly db: Db, private readonly idem: Idempotency) {}

  @Post()
  @Perm('consent.manage')
  prepare(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    return this.svc.prepare(actor, body, req);
  }

  @Get('review-queue')
  @Perm('consent.review')
  queue(@CurrentActor() actor: Actor) {
    return this.db.tx({ centerIds: centersWith(actor, 'consent.review') }, async (c) => {
      const { rows } = await c.query(
        `SELECT cr.id, cr.status, cr.method, cr.scopes, cr.uploaded_at, cr.created_at, p.pseudonym, p.id AS patient_id, d.title AS document_title, d.version AS document_version,
                (SELECT tc.id FROM treatment_case tc WHERE tc.patient_id = p.id ORDER BY tc.created_at LIMIT 1) AS case_id
           FROM consent_record cr JOIN patient p ON p.id = cr.patient_id LEFT JOIN consent_document_version d ON d.id = cr.document_version_id
          WHERE cr.status = 'upload_in_pruefung' ORDER BY cr.uploaded_at`,
      );
      return { items: rows };
    });
  }

  @Post(':id/onsite-link')
  @Perm('consent.manage')
  onsite(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.svc.newOnsiteLink(actor, id, req);
  }

  @Post(':id/evidence')
  @Perm('consent.manage')
  async evidence(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.idem.run(req, actor.userId, `POST /consents/${id}/evidence`, body, async () => ({ status: 201, body: await this.svc.uploadEvidence(actor, id, body, req) }));
    res.status(r.status);
    return r.body;
  }

  @Get(':id/evidence/file')
  @Perm('consent.review')
  async file(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response) {
    const d = await this.svc.evidenceFile(actor, id, req);
    const ext = d.contentType === 'application/pdf' ? 'pdf' : d.contentType === 'image/png' ? 'png' : d.contentType === 'image/jpeg' ? 'jpg' : 'json';
    res.setHeader('Content-Type', d.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="nachweis-${id.slice(0, 8)}.${ext}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(d.contentBase64, 'base64'));
  }

  @Post(':id/review')
  @Perm('consent.review')
  review(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    return this.svc.review(actor, id, body, req);
  }

  @Post(':id/withdraw')
  @Perm('consent.manage')
  withdraw(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ channel: z.enum(['personal', 'schriftlich']), note: z.string().max(1000).optional() }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'consent.manage') }, async (c) => {
      const cr = (await c.query('SELECT center_id FROM consent_record WHERE id = $1', [id])).rows[0];
      if (!cr || !can(actor, 'consent.manage', cr.center_id)) throw notFound();
      return this.svc.withdraw(c, id, actor, b.channel, b.note ?? null, requestIdOf(req));
    });
  }

  @Get('patient/:patientId')
  @Perm('case.read')
  list(@CurrentActor() actor: Actor, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.db.tx({ centerIds: readableCenters(actor) }, async (c) => {
      const { rows } = await c.query('SELECT id, status, method, scopes, signed_date, uploaded_at, reviewed_at, rejection_reason, evidence_package FROM consent_record WHERE patient_id = $1 ORDER BY created_at DESC', [patientId]);
      return { items: rows };
    });
  }
}
