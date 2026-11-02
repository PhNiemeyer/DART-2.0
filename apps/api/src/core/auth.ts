import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CENTER_ROLES, hasPermission, Permission, Role, ROLE_PERMISSIONS } from '@dart/domain';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { loadConfig } from './config';
import { Db } from './db';
import { ApiError } from './errors';

export interface RoleGrant {
  role: Role;
  centerId: string | null;
}

export interface Actor {
  kind: 'nutzer';
  userId: string;
  username: string;
  displayName: string;
  roles: RoleGrant[];
  isDemo: boolean;
}

export const SESSION_COOKIE = 'dart_session';
export const SESSION_TTL_SECONDS = 8 * 3600;

export const IS_PUBLIC = 'dart:public';
export const PERMS = 'dart:perms';
/** Endpunkt ohne Personalanmeldung (Health, Login, Patientenportal mit eigener Sitzung). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Benötigte Berechtigung (in mindestens einem Zentrum bzw. global). Objektprüfung zusätzlich im Service. */
export const Perm = (...p: Permission[]) => SetMetadata(PERMS, p);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return (ctx.switchToHttp().getRequest() as Request & { actor: Actor }).actor;
});

export function rolesOf(a: Actor): Role[] {
  return a.roles.map((r) => r.role);
}

/** Zentren, in denen der Nutzer eine zentrumsgebundene Rolle mit der Berechtigung besitzt. */
export function centersWith(a: Actor, p: Permission): string[] {
  return [...new Set(a.roles.filter((r) => r.centerId && ROLE_PERMISSIONS[r.role]?.includes(p)).map((r) => r.centerId!))];
}

export function can(a: Actor, p: Permission, centerId?: string): boolean {
  if (centerId) return a.roles.some((r) => r.centerId === centerId && ROLE_PERMISSIONS[r.role]?.includes(p));
  return hasPermission(rolesOf(a), p);
}

export function requirePerm(a: Actor, p: Permission, centerId?: string): void {
  if (!can(a, p, centerId)) throw new ApiError(403, 'KEINE_BERECHTIGUNG');
}

/** Alle Zentren mit irgendeinem fachlichen Leserecht → RLS-Kontext. */
export function readableCenters(a: Actor): string[] {
  return centersWith(a, 'case.read');
}

export async function issueSession(userId: string): Promise<string> {
  const cfg = loadConfig();
  return new SignJWT({ typ: 'personal' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setAudience('dart-api')
    .setIssuer('dart-api')
    .sign(cfg.sessionSecret);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const actor = await this.authenticate(req);
    if (!actor) throw new ApiError(401, 'NICHT_ANGEMELDET');
    req.actor = actor;
    const perms = this.reflector.getAllAndOverride<Permission[]>(PERMS, [ctx.getHandler(), ctx.getClass()]) ?? [];
    for (const p of perms) if (!can(actor, p)) throw new ApiError(403, 'KEINE_BERECHTIGUNG');
    return true;
  }

  private async authenticate(req: Request): Promise<Actor | null> {
    const cfg = loadConfig();
    let userId: string | null = null;
    let externalSubject: string | null = null;
    const bearer = req.header('authorization')?.startsWith('Bearer ') ? req.header('authorization')!.slice(7) : null;
    if (bearer && cfg.authMode === 'oidc') {
      jwks ??= createRemoteJWKSet(new URL(`${cfg.oidc.internalIssuer}/protocol/openid-connect/certs`));
      try {
        const { payload } = await jwtVerify(bearer, jwks, { issuer: cfg.oidc.issuer });
        externalSubject = payload.sub ?? null;
      } catch {
        return null;
      }
    } else {
      const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, cfg.sessionSecret, { audience: 'dart-api', issuer: 'dart-api' });
        if (payload.typ !== 'personal') return null;
        userId = payload.sub ?? null;
      } catch {
        return null;
      }
    }
    // Rollen und Sperre bei jeder Anfrage frisch laden: Rechtewechsel/Sperrung sofort wirksam
    const { rows } = await this.db.app.query(
      `SELECT u.id, u.username, u.display_name, u.active, u.is_demo,
              COALESCE(json_agg(json_build_object('role', r.role, 'centerId', r.center_id)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM app_user u
         LEFT JOIN user_center_role r ON r.user_id = u.id AND (r.valid_to IS NULL OR r.valid_to > now())
        WHERE ${userId ? 'u.id = $1' : 'u.external_subject = $1'}
        GROUP BY u.id`,
      [userId ?? externalSubject],
    );
    const u = rows[0];
    if (!u || !u.active) return null;
    const roles = (u.roles as RoleGrant[]).filter((r) => (CENTER_ROLES.includes(r.role) && r.role !== 'datenmanagement' ? !!r.centerId : true));
    return { kind: 'nutzer', userId: u.id, username: u.username, displayName: u.display_name, roles, isDemo: u.is_demo };
  }
}
