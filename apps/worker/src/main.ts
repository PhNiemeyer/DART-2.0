import { createServer } from 'node:http';
import { Pool } from 'pg';
import { processExports } from './exports';
import { smtpProvider } from './mail';
import { runOnce, WorkerDeps } from './outbox';

/** Getrennter Worker: Outbox-Versand (Einladungen, Erinnerungen) und asynchrone Exporte. */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Konfiguration fehlt: ${name}`);
  return v;
}

const env = process.env.NODE_ENV ?? 'development';
const vaultUrl = req('VAULT_URL');
const vaultToken = req('VAULT_TOKEN_WORKER');
if (env === 'production' && (vaultToken.startsWith('demo-') || process.env.MAILPIT_API)) {
  console.error(JSON.stringify({ level: 'fatal', dienst: 'worker', meldung: 'Produktionsstart verweigert: Demo-Token oder Test-Mailadapter (Mailpit) aktiv' }));
  process.exit(1);
}

const pool = new Pool({ connectionString: req('WORKER_DATABASE_URL'), max: 4 });
const deps: WorkerDeps = {
  pool,
  mail: smtpProvider({ host: process.env.SMTP_HOST ?? 'localhost', port: Number(process.env.SMTP_PORT ?? 1025), from: process.env.MAIL_FROM ?? 'DART Register (Demo) <noreply@dart-prototyp.invalid>', mailpitApi: process.env.MAILPIT_API }),
  async contact(vaultRef, centerId) {
    const r = await fetch(`${vaultUrl}/internal/v1/identities/${vaultRef}/contact`, { headers: { authorization: `Bearer ${vaultToken}`, 'x-dart-center-ids': centerId, 'x-dart-actor': 'worker' } });
    if (!r.ok) throw new Error(`Vault ${r.status}`);
    return ((await r.json()) as { email: string | null }).email;
  },
  webUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
  messageDomain: process.env.MESSAGE_DOMAIN ?? 'dart-prototyp.invalid',
  staffDomain: process.env.STAFF_MAIL_DOMAIN ?? 'personal.dart-prototyp.invalid',
};

const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5000);
let lastRun: string | null = null;
let lastError: string | null = null;

async function tick() {
  try {
    const stats = await runOnce(deps);
    const exports = await processExports(pool);
    lastRun = new Date().toISOString();
    lastError = null;
    if (Object.keys(stats).length || exports) console.log(JSON.stringify({ level: 'info', dienst: 'worker', versand: stats, exporte: exports }));
  } catch (e) {
    lastError = (e as Error).message.slice(0, 200);
    console.error(JSON.stringify({ level: 'error', dienst: 'worker', meldung: lastError }));
  } finally {
    setTimeout(tick, intervalMs);
  }
}

createServer((rq, rs) => {
  if (rq.url === '/health') {
    rs.writeHead(lastError ? 503 : 200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ status: lastError ? 'fehler' : 'ok', dienst: 'worker', letzterLauf: lastRun }));
  } else {
    rs.writeHead(404);
    rs.end();
  }
}).listen(Number(process.env.PORT ?? 4200));

console.log(JSON.stringify({ level: 'info', dienst: 'worker', meldung: `Worker gestartet (Intervall ${intervalMs} ms)` }));
void tick();
