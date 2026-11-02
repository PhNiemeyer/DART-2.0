import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { loadConfig } from './config';

// DATE als ISO-String belassen (keine Zeitzonenverschiebung), NUMERIC als Zahl
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export interface DbScope {
  /** Zentren, die per RLS sichtbar sind. */
  centerIds: string[];
  /** Patientensitzung: zusätzliche Einschränkung auf diesen Patienten. */
  patientId?: string;
  auditReader?: boolean;
}

export type Tx = PoolClient;

function pgArray(ids: string[]): string {
  for (const id of ids) if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Ungültige Zentrumskennung');
  return `{${ids.join(',')}}`;
}

@Injectable()
export class Db implements OnModuleDestroy {
  /** Laufzeitrolle dart_app: kein Owner, kein Superuser, kein BYPASSRLS. */
  readonly app: Pool;
  /** Rolle dart_migration: nur Schema legacy. */
  readonly migration: Pool;

  constructor() {
    const cfg = loadConfig();
    this.app = new Pool({ connectionString: cfg.appDatabaseUrl, max: 20 });
    this.migration = new Pool({ connectionString: cfg.migrationDatabaseUrl, max: 4 });
  }

  /** Transaktion mit gesetztem RLS-Kontext (transaktionslokal). */
  async tx<T>(scope: DbScope, fn: (c: Tx) => Promise<T>, pool: Pool = this.app): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.center_ids', $1, true), set_config('app.patient_id', $2, true), set_config('app.audit_reader', $3, true)`,
        [pgArray(scope.centerIds), scope.patientId ?? '', scope.auditReader ? 'on' : 'off'],
      );
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

  async onModuleDestroy() {
    await this.app.end();
    await this.migration.end();
  }
}
