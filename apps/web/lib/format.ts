const DATE = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** ISO-Datum (YYYY-MM-DD) → TT.MM.JJJJ ohne Zeitzonenverschiebung. */
export function fmtDate(iso?: string | null): string {
  if (!iso) return '–';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m && iso.length === 10) return `${m[3]}.${m[2]}.${m[1]}`;
  return DATE.format(new Date(iso));
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '–';
  return DATETIME.format(new Date(iso));
}

export function fmtNumber(n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined) return '–';
  return n.toLocaleString('de-DE', decimals !== undefined ? { minimumFractionDigits: 0, maximumFractionDigits: decimals } : undefined);
}

/** Deutsche Zahleneingabe („4,5“) → Zahl; leer → null; ungültig → NaN. */
export function parseGermanNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^-?\d+([.,]\d+)?$/.test(t)) return NaN;
  return Number(t.replace(',', '.'));
}

export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export const SIDE_LABEL: Record<string, string> = { links: 'links', rechts: 'rechts' };
export const JOINT_LABEL: Record<string, string> = { knie: 'Knie', schulter: 'Schulter', huefte: 'Hüfte', sprunggelenk: 'Sprunggelenk' };
export const CASE_STATUS_LABEL: Record<string, string> = { consent_ausstehend: 'Einwilligung ausstehend', aktiv: 'Aktiv', abgeschlossen: 'Abgeschlossen', gesperrt: 'Gesperrt' };
export const RESPONSE_STATUS_LABEL: Record<string, string> = { entwurf: 'Entwurf', abgeschlossen: 'Abgeschlossen', wiedereroeffnet: 'Wieder geöffnet' };
export const OUTBOX_STATUS_LABEL: Record<string, string> = { ausstehend: 'geplant', in_versand: 'in Versand', versendet: 'versendet', unklar: 'Ergebnis unklar (Abgleich)', fehlgeschlagen: 'fehlgeschlagen (Wiederholung)', dead_letter: 'manuelle Bearbeitung nötig', storniert: 'storniert' };
