/** Hilfsfunktionen für Autoreporting/Benchmarking (deskriptiv, nicht risikoadjustiert). */

/** Altersgruppe (5 Jahre) zum Bezugsdatum; nur die Gruppe wird im pseudonymen Kern gespeichert. */
export function ageGroup(birthDate: string, referenceDate: string): string | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(referenceDate);
  if (!b || !r) return null;
  let age = Number(r[1]) - Number(b[1]);
  if (Number(r[2]) * 100 + Number(r[3]) < Number(b[2]) * 100 + Number(b[3])) age--;
  if (age < 0 || age > 120) return null;
  if (age < 18) return '<18';
  if (age >= 85) return '85+';
  const lo = Math.floor(age / 5) * 5;
  return `${lo}–${lo + 4}`;
}

/** Zweiseitiges 97,5-%-Quantil der t-Verteilung (für 95-%-Konfidenzintervalle), Näherung für df ≥ 1. */
export function tQuantile975(df: number): number {
  const table: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 15: 2.131, 20: 2.086, 30: 2.042, 60: 2.0, 120: 1.98 };
  if (df <= 0) return NaN;
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (df >= 120) return 1.96 + (1.98 - 1.96) * (120 / df);
  const k = keys.find((x) => x >= df)!;
  if (k === df) return table[k];
  const lo = keys[keys.indexOf(k) - 1];
  return table[lo] + ((table[k] - table[lo]) * (df - lo)) / (k - lo);
}

export interface GroupStat {
  n: number;
  mean: number | null;
  sd: number | null;
}

export interface Comparison {
  diff: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  einordnung: 'ueber' | 'unter' | 'im_bereich' | 'zu_wenige_faelle';
}

export const MIN_GROUP = 5;

/**
 * Abweichung der eigenen Gruppe vom Gesamtkollektiv: Differenz der Mittelwerte und 95-%-KI des eigenen Mittelwerts.
 * „über/unter“ nur, wenn das KI den Gesamtwert nicht einschließt. Kein Wirksamkeitsnachweis, nicht risikoadjustiert.
 */
export function compare(own: GroupStat, total: GroupStat): Comparison {
  if (own.n < MIN_GROUP || own.mean === null || total.mean === null || own.sd === null) return { diff: null, ciLow: null, ciHigh: null, einordnung: 'zu_wenige_faelle' };
  const half = tQuantile975(own.n - 1) * (own.sd / Math.sqrt(own.n));
  const lo = own.mean - half;
  const hi = own.mean + half;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { diff: r(own.mean - total.mean), ciLow: r(lo), ciHigh: r(hi), einordnung: lo > total.mean ? 'ueber' : hi < total.mean ? 'unter' : 'im_bereich' };
}
