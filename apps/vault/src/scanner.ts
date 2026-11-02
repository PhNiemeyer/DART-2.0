/**
 * Upload-Prüfung (F13): Größe, erlaubte Typen per Magic Bytes (nicht nur Dateiendung/MIME-Header),
 * Malwareprüfung über austauschbaren Adapter. Der Demo-Adapter erkennt die EICAR-Testsignatur;
 * ohne produktiven Scanner keine Produktionsfreigabe (Startsperre in config.ts).
 */
export type AllowedType = 'application/pdf' | 'image/jpeg' | 'image/png';

export function sniffType(buf: Buffer): AllowedType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export interface ScanResult {
  status: 'sauber' | 'infiziert' | 'abgelehnt';
  detectedType: AllowedType | null;
  detail: string;
}

export interface MalwareScanner {
  name: string;
  scan(buf: Buffer): Promise<{ infected: boolean; signature?: string }>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export const demoScanner: MalwareScanner = {
  name: 'demo-eicar',
  async scan(buf) {
    return buf.includes(Buffer.from(EICAR, 'latin1')) ? { infected: true, signature: 'EICAR-Test-Signature' } : { infected: false };
  },
};

export async function checkUpload(buf: Buffer, declaredType: string, maxBytes: number, scanner: MalwareScanner): Promise<ScanResult> {
  if (buf.length === 0) return { status: 'abgelehnt', detectedType: null, detail: 'Leere Datei' };
  if (buf.length > maxBytes) return { status: 'abgelehnt', detectedType: null, detail: `Datei zu groß (höchstens ${Math.round(maxBytes / 1024 / 1024)} MB)` };
  const detected = sniffType(buf);
  if (!detected) return { status: 'abgelehnt', detectedType: null, detail: 'Nur PDF, JPEG oder PNG zulässig (Dateiinhalt geprüft)' };
  if (declaredType && declaredType !== detected) return { status: 'abgelehnt', detectedType: detected, detail: `Angegebener Typ ${declaredType} passt nicht zum Inhalt (${detected})` };
  const r = await scanner.scan(buf);
  if (r.infected) return { status: 'infiziert', detectedType: detected, detail: `Schadsoftware erkannt: ${r.signature}` };
  return { status: 'sauber', detectedType: detected, detail: `Geprüft mit ${scanner.name}` };
}
