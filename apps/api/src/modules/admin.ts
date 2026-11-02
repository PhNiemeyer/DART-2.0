import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ASSIGNMENT_MATRIX_V1,
  CONSENT_SCOPE_LABELS,
  FOLLOWUP_PLAN_V1,
  JOINTS,
  MODULES,
  MODULE_LABELS,
  OPS_EXAMPLES,
  REGISTERS,
  Role,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from '@dart/domain';
import { SCORE_REGISTRY } from '@dart/forms';
import { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, centersWith, CurrentActor, issueSession, Perm, Public, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../core/auth';
import { loadConfig, todayBerlin } from '../core/config';
import { Db } from '../core/db';
import { ApiError, conflict, notFound, requestIdOf } from '../core/errors';
import { parse, rateLimit } from '../core/http';
import { scienceApproved } from './followup.service';

@ApiTags('Anmeldung')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: loadConfig().cookieSecure, maxAge: SESSION_TTL_SECONDS * 1000, path: '/' });
  }

  @Get('mode')
  @Public()
  mode() {
    const cfg = loadConfig();
    return { authMode: cfg.authMode, environment: cfg.env, demo: cfg.authMode === 'dev' };
  }

  /** Nur lokale Entwicklung: Anmeldung als Demo-Nutzer (in Produktion verweigert). */
  @Get('dev-users')
  @Public()
  async devUsers() {
    if (loadConfig().authMode !== 'dev') throw new ApiError(404, 'NICHT_GEFUNDEN');
    const { rows } = await this.db.app.query(
      `SELECT u.username, u.display_name, array_agg(r.role || COALESCE(':' || c.code, '') ORDER BY r.role) AS roles
         FROM app_user u JOIN user_center_role r ON r.user_id = u.id LEFT JOIN center c ON c.id = r.center_id
        WHERE u.is_demo AND u.active GROUP BY u.id ORDER BY u.username`,
    );
    return { items: rows };
  }

  @Post('dev-login')
  @Public()
  async devLogin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (loadConfig().authMode !== 'dev') throw new ApiError(404, 'NICHT_GEFUNDEN');
    rateLimit(req, 'dev-login', 60, 60_000);
    const { username } = parse(z.object({ username: z.string().max(100) }), body);
    const u = (await this.db.app.query('SELECT id FROM app_user WHERE username = $1 AND is_demo AND active', [username])).rows[0];
    if (!u) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Unbekannter Demo-Nutzer');
    this.setCookie(res, await issueSession(u.id));
    await this.db.tx({ centerIds: [] }, (c) => this.audit.write(c, { kind: 'system' }, { action: 'anmeldung_demo', objectType: 'nutzer', objectId: u.id, requestId: requestIdOf(req) }));
    return { ok: true };
  }

  /** OIDC (Keycloak): Authorization Code Flow mit PKCE und state. */
  @Get('oidc/start')
  @Public()
  oidcStart(@Res() res: Response) {
    const cfg = loadConfig();
    if (cfg.authMode !== 'oidc') throw new ApiError(404, 'NICHT_GEFUNDEN');
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    res.cookie('dart_oidc', JSON.stringify({ verifier, state }), { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, maxAge: 10 * 60_000, path: '/api/v1/auth/oidc' });
    const url = new URL(`${cfg.oidc.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({ client_id: cfg.oidc.clientId, response_type: 'code', scope: 'openid', redirect_uri: cfg.oidc.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    res.redirect(url.toString());
  }

  @Get('oidc/callback')
  @Public()
  async oidcCallback(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const cfg = loadConfig();
    if (cfg.authMode !== 'oidc') throw new ApiError(404, 'NICHT_GEFUNDEN');
    const stored = JSON.parse((req as Request & { cookies: Record<string, string> }).cookies?.dart_oidc ?? '{}');
    if (!q.code || !q.state || q.state !== stored.state) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Ungültige Anmeldeantwort');
    const tokenRes = await fetch(`${cfg.oidc.internalIssuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: cfg.oidc.redirectUri, client_id: cfg.oidc.clientId, client_secret: cfg.oidc.clientSecret, code_verifier: stored.verifier }),
    });
    if (!tokenRes.ok) throw new ApiError(401, 'NICHT_ANGEMELDET', 'Anmeldung beim Identitätsanbieter fehlgeschlagen');
    const tok = (await tokenRes.json()) as { access_token: string };
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(`${cfg.oidc.internalIssuer}/protocol/openid-connect/certs`));
    const { payload } = await jwtVerify(tok.access_token, jwks, { issuer: cfg.oidc.issuer });
    const username = String(payload.preferred_username ?? '');
    // Erstanmeldung bindet den Keycloak-Subject an das zentral angelegte Konto (keine Selbstregistrierung)
    const u = (await this.db.app.query(
      `UPDATE app_user SET external_subject = COALESCE(external_subject, $1) WHERE username = $2 AND active AND (external_subject IS NULL OR external_subject = $1) RETURNING id`,
      [payload.sub, username],
    )).rows[0];
    if (!u) throw new ApiError(403, 'KEINE_BERECHTIGUNG', 'Für dieses Konto ist kein DART-Zugang angelegt.');
    res.clearCookie('dart_oidc', { path: '/api/v1/auth/oidc' });
    this.setCookie(res, await issueSession(u.id));
    res.redirect(cfg.oidc.postLoginRedirect);
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    const { rows } = await this.db.app.query('SELECT id, code, name FROM center WHERE id = ANY($1::uuid[]) ORDER BY name', [actor.roles.map((r) => r.centerId).filter(Boolean)]);
    const perms = [...new Set(actor.roles.flatMap((r) => ROLE_PERMISSIONS[r.role] ?? []))];
    return {
      userId: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      roles: actor.roles.map((r) => ({ ...r, label: ROLE_LABELS[r.role] })),
      centers: rows,
      permissions: perms,
      isDemo: actor.isDemo,
    };
  }

  @Post('logout')
  @Public()
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}

@ApiTags('Stammdaten')
@Controller('api/v1/meta')
export class MetaController {
  constructor(private readonly db: Db) {}

  @Get('catalog')
  catalog() {
    return {
      joints: JOINTS,
      registers: REGISTERS,
      modules: MODULES,
      moduleLabels: MODULE_LABELS,
      consentScopes: CONSENT_SCOPE_LABELS,
      followUpPlan: FOLLOWUP_PLAN_V1,
      assignmentMatrix: ASSIGNMENT_MATRIX_V1,
      roles: ROLE_LABELS,
      rolePermissions: ROLE_PERMISSIONS,
      scores: Object.entries(SCORE_REGISTRY).map(([ref, s]) => ({ ref, name: s.name, description: s.description, unit: s.unit, range: s.range, direction: s.direction, rounding: s.rounding, maxMissingShare: s.maxMissingShare })),
    };
  }

  @Get('ops')
  ops(@Query('q') q = '') {
    const term = q.toLowerCase().trim();
    return { version: OPS_EXAMPLES[0].version, hinweis: 'Beispielkatalog – vor Pilot gegen die amtliche OPS-Version prüfen.', items: OPS_EXAMPLES.filter((o) => !term || o.code.includes(term) || o.label.toLowerCase().includes(term) || o.concept.toLowerCase().includes(term)).slice(0, 30) };
  }

  @Get('consent-documents')
  async consentDocs() {
    const { rows } = await this.db.app.query('SELECT id, code, version, title, body, body_sha256, scopes, is_demo FROM consent_document_version WHERE active ORDER BY code, version');
    return { items: rows };
  }

  @Get('centers/:id/staff')
  async staff(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    if (!centersWith(actor, 'case.read').includes(id)) throw notFound();
    const { rows } = await this.db.app.query(`SELECT u.id, u.display_name FROM user_center_role r JOIN app_user u ON u.id = r.user_id WHERE r.center_id = $1 AND r.role = 'arzt' AND u.active ORDER BY u.display_name`, [id]);
    const science = await this.db.tx({ centerIds: [] }, (c) => scienceApproved(c, id));
    return { surgeons: rows, scienceApproved: science, stichtag: todayBerlin() };
  }
}

@ApiTags('Administration')
@Controller('api/v1/admin')
@Perm('admin.manage')
export class AdminController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  @Get('centers')
  async centers() {
    const { rows } = await this.db.app.query(
      `SELECT c.*, (SELECT json_agg(a ORDER BY a.valid_from) FROM center_science_approval a WHERE a.center_id = c.id) AS science_approvals FROM center c ORDER BY c.name`,
    );
    return { items: rows };
  }

  @Post('centers')
  async createCenter(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9-]{2,20}$/), name: z.string().min(2).max(200) }), body);
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('INSERT INTO center (code, name) VALUES ($1,$2) RETURNING id', [b.code, b.name]);
      await this.audit.write(c, actor, { action: 'zentrum_anlegen', objectType: 'zentrum', objectId: r.rows[0].id, requestId: requestIdOf(req) });
      return { id: r.rows[0].id };
    });
  }

  @Post('centers/:id/science-approval')
  async science(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), approvedBy: z.string().min(2).max(200), reference: z.string().max(200).optional() }), body);
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('INSERT INTO center_science_approval (center_id, valid_from, valid_to, approved_by, reference) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, b.validFrom, b.validTo ?? null, b.approvedBy, b.reference ?? null]);
      await this.audit.write(c, actor, { action: 'science_freigabe', objectType: 'zentrum', objectId: id, centerId: id, requestId: requestIdOf(req) });
      return { id: r.rows[0].id };
    });
  }

  @Get('users')
  async users() {
    const { rows } = await this.db.app.query(
      `SELECT u.id, u.username, u.display_name, u.active, u.locked_reason, u.is_demo,
              COALESCE(json_agg(json_build_object('id', r.id, 'role', r.role, 'centerId', r.center_id, 'centerName', c.name)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM app_user u LEFT JOIN user_center_role r ON r.user_id = u.id LEFT JOIN center c ON c.id = r.center_id
        GROUP BY u.id ORDER BY u.username`,
    );
    return { items: rows };
  }

  /** Keine Selbstregistrierung: Konten werden zentral angelegt (F01). */
  @Post('users')
  async createUser(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ username: z.string().regex(/^[a-z0-9._-]{3,60}$/), displayName: z.string().min(2).max(200) }), body);
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('INSERT INTO app_user (username, display_name) VALUES ($1,$2) RETURNING id', [b.username, b.displayName]);
      await this.audit.write(c, actor, { action: 'nutzer_anlegen', objectType: 'nutzer', objectId: r.rows[0].id, requestId: requestIdOf(req) });
      return { id: r.rows[0].id };
    });
  }

  @Post('users/:id/roles')
  async grant(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ role: z.enum(Object.keys(ROLE_LABELS) as [Role, ...Role[]]), centerId: z.string().uuid().nullable() }), body);
    const centerBound: Role[] = ['zentrumsverantwortlich', 'arzt', 'dokumentation'];
    if (centerBound.includes(b.role) && !b.centerId) throw new ApiError(400, 'VALIDIERUNG', 'Diese Rolle ist zentrumsgebunden.');
    if (!centerBound.includes(b.role) && b.role !== 'datenmanagement' && b.centerId) throw new ApiError(400, 'VALIDIERUNG', 'Diese Rolle ist nicht zentrumsgebunden.');
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('INSERT INTO user_center_role (user_id, center_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [id, b.centerId, b.role, actor.userId]);
      if (!r.rows.length) throw conflict('KONFLIKT', 'Rolle bereits vergeben.');
      await this.audit.write(c, actor, { action: 'rolle_vergeben', objectType: 'nutzer', objectId: id, centerId: b.centerId, reason: b.role, requestId: requestIdOf(req) });
      return { id: r.rows[0].id };
    });
  }

  @Post('users/:id/roles/:roleId/revoke')
  async revoke(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('roleId', ParseUUIDPipe) roleId: string, @Req() req: Request) {
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('DELETE FROM user_center_role WHERE id = $1 AND user_id = $2 RETURNING role, center_id', [roleId, id]);
      if (!r.rows.length) throw notFound();
      await this.audit.write(c, actor, { action: 'rolle_entzogen', objectType: 'nutzer', objectId: id, centerId: r.rows[0].center_id, reason: r.rows[0].role, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  @Post('users/:id/lock')
  async lock(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ locked: z.boolean(), reason: z.string().min(3).max(500) }), body);
    if (id === actor.userId) throw new ApiError(400, 'VALIDIERUNG', 'Das eigene Konto kann nicht gesperrt werden.');
    return this.db.tx({ centerIds: [] }, async (c) => {
      const r = await c.query('UPDATE app_user SET active = $2, locked_reason = $3 WHERE id = $1 RETURNING id', [id, !b.locked, b.locked ? b.reason : null]);
      if (!r.rows.length) throw notFound();
      await this.audit.write(c, actor, { action: b.locked ? 'nutzer_sperren' : 'nutzer_entsperren', objectType: 'nutzer', objectId: id, reason: b.reason, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  @Get('audit')
  @Perm('audit.read')
  async auditLog(@Query('objectId') objectId?: string, @Query('limit') limit = '100') {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.tx({ centerIds: [], auditReader: true }, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.at, a.actor_kind, a.actor_roles, u.username, a.center_id, a.action, a.object_type, a.object_id, a.result, a.revision, a.reason, a.request_id
           FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_user_id
          WHERE ($1::text IS NULL OR a.object_id = $1) ORDER BY a.id DESC LIMIT ${n}`,
        [objectId ?? null],
      );
      return { items: rows };
    });
  }
}
