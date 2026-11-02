import { Injectable } from '@nestjs/common';
import { Actor, rolesOf } from './auth';
import { Db, Tx } from './db';

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  centerId?: string | null;
  result?: 'erfolg' | 'abgelehnt' | 'fehler';
  revision?: number | null;
  reason?: string | null;
  requestId?: string;
}

export type AuditActor = Actor | { kind: 'patient'; patientId: string } | { kind: 'system' };

/**
 * Fachaudit: Akteur, Rolle, Zentrum, Aktion, Objekt, UTC-Zeit, Ergebnis, Revision, Änderungsgrund.
 * Keine Freitextantworten, Tokens oder Signaturen im Audit.
 */
@Injectable()
export class Audit {
  constructor(private readonly db: Db) {}

  async write(c: Tx, actor: AuditActor, e: AuditEntry): Promise<void> {
    await c.query(
      `INSERT INTO audit_event (actor_user_id, actor_kind, actor_roles, center_id, action, object_type, object_id, result, revision, reason, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actor.kind === 'nutzer' ? actor.userId : null,
        actor.kind,
        actor.kind === 'nutzer' ? rolesOf(actor) : actor.kind === 'patient' ? ['patient'] : [],
        e.centerId ?? null,
        e.action,
        e.objectType,
        e.objectId ?? (actor.kind === 'patient' ? actor.patientId : null),
        e.result ?? 'erfolg',
        e.revision ?? null,
        e.reason ?? null,
        e.requestId ?? null,
      ],
    );
  }

  /** Abgelehnte Zugriffe in eigener Transaktion protokollieren (best effort). */
  async denied(actor: AuditActor, e: AuditEntry): Promise<void> {
    try {
      await this.db.tx({ centerIds: [] }, (c) => this.write(c, actor, { ...e, result: 'abgelehnt' }));
    } catch {
      /* Audit-Fehler dürfen die Ablehnung nicht verdecken */
    }
  }
}
