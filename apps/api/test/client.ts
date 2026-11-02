/** Minimaler HTTP-Testclient mit Cookie-Jar gegen die laufende API (synthetische Daten). */
export const API = process.env.API_URL ?? 'http://localhost:4000';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  private cookies = new Map<string, string>();

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { 'x-dart-csrf': '1', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Binärantwort */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(p: string) {
    return this.req<T>('GET', p);
  }
  post<T = any>(p: string, b?: unknown, h?: Record<string, string>) {
    return this.req<T>('POST', p, b ?? {}, h);
  }
  patch<T = any>(p: string, b?: unknown, h?: Record<string, string>) {
    return this.req<T>('PATCH', p, b, h);
  }
  put<T = any>(p: string, b?: unknown) {
    return this.req<T>('PUT', p, b);
  }

  static async login(username: string): Promise<Client> {
    const c = new Client();
    const r = await c.post('/api/v1/auth/dev-login', { username });
    if (r.status !== 201 && r.status !== 200) throw new Error(`Login ${username} fehlgeschlagen: ${r.status} ${JSON.stringify(r.body)}`);
    return c;
  }
}

let counter = 0;
export function uniqueName(prefix = 'Test') {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export async function centerIds(c: Client): Promise<Record<string, string>> {
  const me = await c.get('/api/v1/auth/me');
  return Object.fromEntries(me.body.centers.map((x: { code: string; id: string }) => [x.code, x.id]));
}

export async function consentDocId(c: Client): Promise<string> {
  return (await c.get('/api/v1/meta/consent-documents')).body.items[0].id;
}

export function caseBody(centerId: string, over: Record<string, unknown> = {}) {
  return {
    patient: { firstName: 'Erika', lastName: uniqueName('Synth'), email: `${uniqueName('p').toLowerCase()}@example.invalid` },
    centerId,
    joint: 'knie',
    side: 'links',
    treatmentType: 'operativ',
    plannedOpDate: '2026-11-10',
    mode: 'basic',
    registers: ['DART'],
    modules: [],
    procedures: [],
    ...over,
  };
}

/** Vollständiger digitaler Einwilligungsweg über das Patientenportal (Demo-Signatur). */
export async function digitalConsent(staff: Client, patientId: string, scopes: string[] = ['register_basic', 'kontakt_followup']) {
  const docId = await consentDocId(staff);
  const prep = await staff.post('/api/v1/consents', { patientId, documentVersionId: docId, scopes, method: 'digital_demo', informedBy: 'Dr. Test' });
  if (prep.status !== 201) throw new Error(`Consent prepare: ${prep.status} ${JSON.stringify(prep.body)}`);
  const patient = new Client();
  const red = await patient.post('/api/v1/portal/redeem', { token: prep.body.onsite.token });
  if (red.status !== 201) throw new Error(`Redeem: ${red.status} ${JSON.stringify(red.body)}`);
  const ver = await patient.post('/api/v1/portal/verify', { code: prep.body.onsite.accessCode });
  if (!ver.body.ok) throw new Error(`Verify: ${JSON.stringify(ver.body)}`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const sign = await patient.post(`/api/v1/portal/consents/${prep.body.id}/sign`, {
    acceptedScopes: scopes,
    confirmRead: true,
    signature: { kind: 'getippt', typedName: 'Erika Synthetisch' },
    signedDate: process.env.DART_TODAY ?? today,
  });
  if (sign.status !== 201) throw new Error(`Sign: ${sign.status} ${JSON.stringify(sign.body)}`);
  return { consentId: prep.body.id as string, patient, onsite: prep.body.onsite };
}

export const PDF = Buffer.from('%PDF-1.4\n% synthetischer Demonstrationsnachweis\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
export const EICAR = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n').toString('base64');
