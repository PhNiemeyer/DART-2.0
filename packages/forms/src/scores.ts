/**
 * Versionierte Scorealgorithmen (F10).
 *
 * WICHTIG: Im Prototyp existiert ausschließlich ein ausdrücklich so benannter
 * „Demonstrationsscore“. KOOS, EQ-5D, Marx, IKDC, Oxford u. a. werden NICHT
 * implementiert oder interpretiert, solange Lizenz und fachliche Prüfung fehlen.
 */

export interface ScoreResult {
  value: number | null;
  /** Deutsche Begründung, wenn kein Wert berechnet werden konnte. */
  reason?: string;
  usedInputs: number;
  totalInputs: number;
}

export interface ScoreAlgorithmVersion {
  code: string;
  version: number;
  name: string;
  description: string;
  unit: string;
  range: [number, number];
  direction: string;
  rounding: string;
  /** Maximal zulässiger Anteil fehlender Eingaben (0–1). */
  maxMissingShare: number;
  inputScale: [number, number];
  compute(values: Array<number | undefined>): ScoreResult;
}

export function roundHalfAwayFromZero(x: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
  return Object.is(r, -0) ? 0 : r;
}

export const DEMO_SCORE_V1: ScoreAlgorithmVersion = {
  code: 'DEMO-SCORE',
  version: 1,
  name: 'Demonstrationsscore (kein validiertes Instrument)',
  description:
    'Eigener Demonstrationsalgorithmus für den Prototyp: Mittelwert der gültigen Eingaben (Skala 0–4), ' +
    'linear auf 0–100 transformiert. Keine klinische Aussagekraft.',
  unit: 'Punkte',
  range: [0, 100],
  direction: 'Höherer Wert = günstigere Selbstauskunft (nur Demonstration)',
  rounding: 'Eine Nachkommastelle, kaufmännisch (halb weg von null)',
  maxMissingShare: 0.5,
  inputScale: [0, 4],
  compute(values) {
    const total = values.length;
    const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 4);
    const missing = total - valid.length;
    if (total === 0) return { value: null, reason: 'Keine Eingangsvariablen definiert', usedInputs: 0, totalInputs: 0 };
    if (missing / total > this.maxMissingShare) {
      return {
        value: null,
        reason: `Zu viele fehlende Angaben (${missing} von ${total}; zulässig höchstens ${Math.floor(total * this.maxMissingShare)})`,
        usedInputs: valid.length,
        totalInputs: total,
      };
    }
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    return { value: roundHalfAwayFromZero((mean / 4) * 100, 1), usedInputs: valid.length, totalInputs: total };
  },
};

export const SCORE_REGISTRY: Record<string, ScoreAlgorithmVersion> = {
  'DEMO-SCORE@1': DEMO_SCORE_V1,
};

export function getScoreAlgorithm(ref: string): ScoreAlgorithmVersion | undefined {
  return SCORE_REGISTRY[ref];
}
