import { NextRequest } from 'next/server';

/**
 * Serverseitiger Proxy zur API (Laufzeitkonfiguration API_INTERNAL_URL). Antworten werden nicht gecacht.
 * Leitet nur benötigte Header weiter; keine Protokollierung von Inhalten.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD_REQ = ['cookie', 'content-type', 'if-match', 'idempotency-key', 'x-dart-csrf', 'accept'];
const FORWARD_RES = ['content-type', 'content-disposition', 'etag', 'x-request-id', 'idempotent-replay', 'x-checksum-sha256', 'location'];

async function proxy(req: NextRequest): Promise<Response> {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const url = `${base}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const headers = new Headers();
  for (const h of FORWARD_REQ) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) headers.set('x-forwarded-for', fwd);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let res: Response;
  try {
    res = await fetch(url, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual', cache: 'no-store' });
  } catch {
    return Response.json({ code: 'INTERN', message: 'Der Server ist nicht erreichbar. Bitte versuchen Sie es später erneut.' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const out = new Headers({ 'cache-control': 'private, no-store' });
  for (const h of FORWARD_RES) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
