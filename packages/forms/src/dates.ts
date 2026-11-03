import { isValidIsoDate } from './engine';

/**
 * Deutsche Datumseingabe (TT.MM.JJJJ) unabhängig von der Browsersprache.
 * Akzeptiert: 1.2.2026, 01.02.2026, 01022026, 2026-02-01 (Einfügen). Zweistellige Jahre werden abgelehnt.
 * Ergebnis: ISO-Datum, '' für leer, oder null für ungültig/unvollständig.
 */
export function parseGermanDate(input: string): string | '' | null {
  const s = input.trim();
  if (!s) return '';
  let d: number, m: number, y: number;
  let match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (match) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** ISO-Datum → TT.MM.JJJJ (ohne Zeitzonenverschiebung). */
export function formatGermanDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
