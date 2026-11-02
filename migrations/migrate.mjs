// Einfacher, transaktionaler Migrationsläufer mit Prüfsummen.
// Aufruf: node migrate.mjs <core|vault>   (URL aus CORE_MIGRATION_URL bzw. VAULT_MIGRATION_URL)
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const target = process.argv[2];
if (!['core', 'vault'].includes(target)) {
  console.error('Aufruf: node migrate.mjs <core|vault>');
  process.exit(2);
}
const url = target === 'core' ? process.env.CORE_MIGRATION_URL : process.env.VAULT_MIGRATION_URL;
if (!url) {
  console.error(`Umgebungsvariable ${target === 'core' ? 'CORE_MIGRATION_URL' : 'VAULT_MIGRATION_URL'} fehlt`);
  process.exit(2);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), target);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query('REVOKE ALL ON schema_migrations FROM PUBLIC');
  const { rows } = await client.query('SELECT file, sha256 FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.file, r.sha256]));
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    if (applied.has(f)) {
      if (applied.get(f) !== sha) throw new Error(`Migration ${f} wurde nach dem Einspielen verändert (Prüfsumme abweichend)`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (file, sha256) VALUES ($1, $2)', [f, sha]);
      await client.query('COMMIT');
      console.log(`[migration:${target}] eingespielt: ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} fehlgeschlagen: ${e.message}`);
    }
  }
  console.log(`[migration:${target}] aktuell (${files.length} Dateien)`);
} finally {
  await client.end();
}
