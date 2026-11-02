'use client';

export class ApiErr extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Fetch-Wrapper: CSRF-Header, JSON, deutsche Fehlermeldungen aus der API. */
export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-dart-csrf': '1', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiErr(0, 'NETZWERK', 'Keine Verbindung zum Server. Ihre letzte Änderung wurde nicht gespeichert.', null);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiErr(res.status, body?.code ?? 'FEHLER', body?.message ?? `Fehler ${res.status}`, body);
  return body as T;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(file);
  });
}
