/**
 * CSV-Export (UTF-8, Semikolon) mit Schutz vor Formelinjektion (F19, T04).
 * Zellen, die mit = + - @ Tab oder CR beginnen, werden mit einem Apostroph entschärft.
 */
const DANGEROUS = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return DANGEROUS.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (Array.isArray(value)) s = value.join('|');
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else s = String(value);
  // Reine Zahlen (auch negative) bleiben Zahlen; alle anderen Strings werden geprüft.
  if (!(typeof value === 'number')) s = neutralizeFormula(s);
  if (/[";\n\r]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(csvCell).join(';')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(';'));
  return `${lines.join('\r\n')}\r\n`;
}

/** Kleine Zellen (k-Anonymitäts-Schwelle) für Berichte/Exporte unterdrücken. */
export const SMALL_CELL_THRESHOLD = 5;

export function suppressSmall(n: number, threshold = SMALL_CELL_THRESHOLD): number | string {
  return n > 0 && n < threshold ? `<${threshold}` : n;
}
