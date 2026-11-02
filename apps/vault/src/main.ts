import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { loadConfig } from './config';
import { decrypt, encrypt, hashSecret, nameIndex, newAccessCode, sha256, verifySecret } from './crypto';
import { checkUpload, demoScanner } from './scanner';
import { createStorage } from './storage';

/**
 * Identity Vault: eigenständige Sicherheitsgrenze. Nur Diensttoken-authentisierte Aufrufer
 * (API, Worker). Jeder Zugriff wird im Zugriffsprotokoll festgehalten. Keine Inhalte in Betriebslogs.
 */
let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(JSON.stringify({ level: 'fatal', dienst: 'vault', meldung: (e as Error).message }));
  process.exit(1);
}
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
const storage = createStorage(cfg);

type Caller = 'api' | 'worker';
interface Ctx {
  caller: Caller;
  actor: string | null;
  centerIds: string[];
  requestId: string;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: Math.ceil(cfg.maxUploadBytes * 1.4) + 100_000 }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', dienst: 'vault' });
});

function ctxOf(req: Request): Ctx {
  return (req as Request & { ctx: Ctx }).ctx;
}

app.use('/internal', (req, _res, next) => {
  const auth = req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const caller = cfg.callers[token] as Caller | undefined;
  if (!caller) return next(new HttpError(401, 'NICHT_ANGEMELDET', 'Dienst nicht authentisiert'));
  const centerIds = (req.header('x-dart-center-ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  (req as Request & { ctx: Ctx }).ctx = {
    caller,
    actor: req.header('x-dart-actor') ?? null,
    centerIds,
    requestId: req.header('x-request-id') ?? randomUUID(),
  };
  next();
});

function only(...callers: Caller[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!callers.includes(ctxOf(req).caller)) return next(new HttpError(403, 'KEINE_BERECHTIGUNG', 'Aufrufer nicht berechtigt'));
    next();
  };
}

async function log(ctx: Ctx, action: string, result: string, vaultRef?: string | null, documentId?: string | null) {
  await pool.query(
    'INSERT INTO access_log (caller, actor, action, vault_ref, document_id, result, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [ctx.caller, ctx.actor, action, vaultRef ?? null, documentId ?? null, result, ctx.requestId],
  );
}

async function loadIdentity(ctx: Ctx, ref: string) {
  if (!z.string().uuid().safeParse(ref).success) throw new HttpError(404, 'NICHT_GEFUNDEN', 'Nicht gefunden');
  const { rows } = await pool.query('SELECT * FROM identity WHERE vault_ref = $1', [ref]);
  const row = rows[0];
  // Zentrumsprüfung: unbekannt und fremd sind nicht unterscheidbar (keine Existenzpreisgabe)
  if (!row || !ctx.centerIds.includes(row.center_id)) {
    await log(ctx, 'identitaet_lesen', 'abgelehnt', ref);
    throw new HttpError(404, 'NICHT_GEFUNDEN', 'Nicht gefunden');
  }
  return row;
}

const dec = (b: Buffer | null) => (b ? decrypt(cfg.dataKey, b).toString('utf8') : null);

const IdentityInput = z.object({
  centerId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')),
  synthetic: z.boolean().default(true),
});

app.post('/internal/v1/identities', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = IdentityInput.parse(req.body);
  if (!ctx.centerIds.includes(b.centerId)) throw new HttpError(403, 'KEINE_BERECHTIGUNG', 'Zentrum nicht zulässig');
  const { rows } = await pool.query(
    `INSERT INTO identity (center_id, first_name_enc, last_name_enc, email_enc, birth_date_enc, last_name_hmac, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING vault_ref`,
    [
      b.centerId,
      encrypt(cfg.dataKey, b.firstName),
      encrypt(cfg.dataKey, b.lastName),
      b.email ? encrypt(cfg.dataKey, b.email) : null,
      b.birthDate ? encrypt(cfg.dataKey, b.birthDate) : null,
      nameIndex(cfg.indexKey, b.lastName),
      b.synthetic,
    ],
  );
  await log(ctx, 'identitaet_anlegen', 'erfolg', rows[0].vault_ref);
  res.status(201).json({ vaultRef: rows[0].vault_ref });
});

app.get('/internal/v1/identities/:ref', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const row = await loadIdentity(ctx, String(req.params.ref));
  await log(ctx, 'identitaet_lesen', 'erfolg', row.vault_ref);
  res.json({
    vaultRef: row.vault_ref,
    firstName: dec(row.first_name_enc),
    lastName: dec(row.last_name_enc),
    email: dec(row.email_enc),
    birthDate: dec(row.birth_date_enc),
    hasAccessCode: !!row.access_code_hash,
  });
});

app.post('/internal/v1/identities/batch', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const refs = z.object({ refs: z.array(z.string().uuid()).max(200) }).parse(req.body).refs;
  const { rows } = await pool.query('SELECT vault_ref, center_id, first_name_enc, last_name_enc FROM identity WHERE vault_ref = ANY($1::uuid[])', [refs]);
  const out = rows
    .filter((r) => ctx.centerIds.includes(r.center_id))
    .map((r) => ({ vaultRef: r.vault_ref, firstName: dec(r.first_name_enc), lastName: dec(r.last_name_enc) }));
  await log(ctx, 'identitaet_liste', 'erfolg');
  res.json({ items: out });
});

app.post('/internal/v1/identities/search', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const { lastName } = z.object({ lastName: z.string().trim().min(2).max(100) }).parse(req.body);
  const { rows } = await pool.query('SELECT vault_ref FROM identity WHERE center_id = ANY($1::uuid[]) AND last_name_hmac = $2 LIMIT 50', [
    ctx.centerIds,
    nameIndex(cfg.indexKey, lastName),
  ]);
  await log(ctx, 'klarnamensuche', 'erfolg');
  res.json({ vaultRefs: rows.map((r) => r.vault_ref) });
});

app.post('/internal/v1/identities/:ref/access-code', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const row = await loadIdentity(ctx, String(req.params.ref));
  const code = newAccessCode();
  await pool.query('UPDATE identity SET access_code_hash = $1, access_code_set_at = now(), updated_at = now() WHERE vault_ref = $2', [hashSecret(code), row.vault_ref]);
  await log(ctx, 'zugangscode_neu', 'erfolg', row.vault_ref);
  // Klartext nur einmalig zur Übergabe vor Ort
  res.json({ accessCode: code });
});

app.post('/internal/v1/identities/:ref/verify-access-code', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const row = await loadIdentity(ctx, String(req.params.ref));
  const { code } = z.object({ code: z.string().trim().min(4).max(20) }).parse(req.body);
  const ok = !!row.access_code_hash && verifySecret(code, row.access_code_hash);
  await log(ctx, 'zugangscode_pruefen', ok ? 'erfolg' : 'abgelehnt', row.vault_ref);
  res.json({ ok });
});

app.get('/internal/v1/identities/:ref/contact', only('worker', 'api'), async (req, res) => {
  const ctx = ctxOf(req);
  const row = await loadIdentity(ctx, String(req.params.ref));
  await log(ctx, 'kontakt_lesen', 'erfolg', row.vault_ref);
  res.json({ email: dec(row.email_enc) });
});

const DocumentInput = z.object({
  vaultRef: z.string().uuid(),
  kind: z.enum(['einwilligung_papier', 'signatur_demo', 'einwilligung_kopie']),
  originalName: z.string().max(200).optional(),
  contentType: z.string().max(100),
  contentBase64: z.string().min(1),
});

app.post('/internal/v1/documents', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = DocumentInput.parse(req.body);
  const identity = await loadIdentity(ctx, b.vaultRef);
  const buf = Buffer.from(b.contentBase64, 'base64');
  let status: 'quarantaene' | 'sauber' | 'infiziert' | 'abgelehnt';
  let detail: string;
  let contentType = b.contentType;
  if (b.kind === 'einwilligung_kopie') {
    // intern erzeugtes Nachweispaket (JSON), keine Fremddatei
    if (b.contentType !== 'application/json') throw new HttpError(400, 'VALIDIERUNG', 'Nachweispaket muss JSON sein');
    status = 'sauber';
    detail = 'Intern erzeugtes Nachweispaket';
  } else {
    const r = await checkUpload(buf, b.contentType, cfg.maxUploadBytes, demoScanner);
    status = r.status;
    detail = r.detail;
    contentType = r.detectedType ?? b.contentType;
    if (b.kind === 'signatur_demo' && r.detectedType !== 'image/png' && r.status === 'sauber') {
      status = 'abgelehnt';
      detail = 'Signaturbild muss PNG sein';
    }
  }
  const id = randomUUID();
  const hash = sha256(buf);
  // Abgelehnte/infizierte Dateien werden NICHT gespeichert; Metadaten bleiben zur Nachvollziehbarkeit.
  const storageKey = `${status === 'sauber' ? 'dokumente' : 'quarantaene'}/${identity.center_id}/${id}`;
  if (status === 'sauber') await storage.put(storageKey, encrypt(cfg.dataKey, buf, `doc:${id}`));
  await pool.query(
    `INSERT INTO document (id, vault_ref, center_id, kind, original_name, content_type, size_bytes, sha256, storage_key, scan_status, scan_detail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, identity.vault_ref, identity.center_id, b.kind, b.originalName ?? null, contentType, buf.length, hash, storageKey, status, detail, `${ctx.caller}:${ctx.actor ?? '-'}`],
  );
  await log(ctx, 'dokument_speichern', status, identity.vault_ref, id);
  res.status(status === 'sauber' ? 201 : 422).json({ documentId: id, sha256: hash, scanStatus: status, detail, contentType });
});

app.get('/internal/v1/documents/:id', only('api'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = String(req.params.id);
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'NICHT_GEFUNDEN', 'Nicht gefunden');
  const { rows } = await pool.query('SELECT * FROM document WHERE id = $1', [id]);
  const d = rows[0];
  if (!d || !ctx.centerIds.includes(d.center_id) || d.scan_status !== 'sauber') {
    await log(ctx, 'dokument_lesen', 'abgelehnt', null, id);
    throw new HttpError(404, 'NICHT_GEFUNDEN', 'Nicht gefunden');
  }
  const plain = decrypt(cfg.dataKey, await storage.get(d.storage_key), `doc:${id}`);
  if (sha256(plain) !== d.sha256) throw new HttpError(500, 'INTERN', 'Integritätsprüfung fehlgeschlagen');
  await log(ctx, 'dokument_lesen', 'erfolg', d.vault_ref, id);
  res.json({ documentId: id, contentType: d.content_type, sha256: d.sha256, kind: d.kind, contentBase64: plain.toString('base64') });
});

app.use((_req, _res, next) => next(new HttpError(404, 'NICHT_GEFUNDEN', 'Nicht gefunden')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as Request & { ctx?: Ctx }).ctx?.requestId ?? randomUUID();
  if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message, request_id: requestId });
  if (err instanceof z.ZodError) return res.status(400).json({ code: 'VALIDIERUNG', message: 'Ungültige Eingabe', request_id: requestId, details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if ((err as { type?: string }).type === 'entity.too.large') return res.status(413).json({ code: 'UPLOAD_ABGELEHNT', message: 'Datei zu groß', request_id: requestId });
  // Betriebslog ohne Inhalte
  console.error(JSON.stringify({ level: 'error', dienst: 'vault', request_id: requestId, fehler: (err as Error).name, meldung: (err as Error).message?.slice(0, 200) }));
  res.status(500).json({ code: 'INTERN', message: 'Interner Fehler', request_id: requestId });
});

async function main() {
  await storage.ready();
  app.listen(cfg.port, () => console.log(JSON.stringify({ level: 'info', dienst: 'vault', meldung: `Vault läuft auf Port ${cfg.port}`, umgebung: cfg.env, speicher: cfg.storage })));
}
main().catch((e) => {
  console.error(JSON.stringify({ level: 'fatal', dienst: 'vault', meldung: (e as Error).message }));
  process.exit(1);
});
