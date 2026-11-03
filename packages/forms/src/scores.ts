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
  /** Fachlicher Freigabestatus (Lastenheft E-09). */
  status: 'demonstration' | 'freigabe_ausstehend' | 'freigegeben';
  /** Quelle des Scoringverfahrens. */
  quelle?: string;
  /** maxima: maximaler Itemwert je Eingang (nach Umrechnung), falls bekannt. */
  compute(values: Array<number | undefined>, maxima?: Array<number | undefined>): ScoreResult;
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
  status: 'demonstration',
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

/**
 * IKDC Subjective Knee Evaluation Form – Scoring nach publizierter Anleitung (Irrgang et al. 2001):
 * Itemwerte so umgerechnet, dass der niedrigste Wert 0 ist; Summe geteilt durch die maximal mögliche Summe
 * der beantworteten Items × 100. Mindestens 16 der 18 bewerteten Items (Item 10a „vor der Verletzung“ zählt nicht).
 * STATUS: Freigabe ausstehend (E-09). Itemumrechnung aus V05 (Blatt IK) abgeleitet und fachlich zu bestätigen.
 */
export const IKDC_V1: ScoreAlgorithmVersion = {
  code: 'IKDC',
  version: 1,
  name: 'IKDC Subjective Knee Form (Scoring – Freigabe ausstehend)',
  description: 'Summe der umgerechneten Itemwerte / maximal mögliche Summe der beantworteten Items × 100; mindestens 16 von 18 Items.',
  unit: 'Punkte',
  range: [0, 100],
  direction: 'Höherer Wert = bessere Kniefunktion',
  rounding: 'Eine Nachkommastelle, kaufmännisch',
  maxMissingShare: 2 / 18,
  inputScale: [0, 10],
  status: 'freigabe_ausstehend',
  quelle: 'Irrgang JJ et al., Am J Sports Med 2001; Scoring-Anleitung IKDC 2000 – vor Freigabe gegen das lizenzierte Manual prüfen',
  compute(values, maxima) {
    const total = values.length;
    if (!maxima || maxima.some((m) => m === undefined)) return { value: null, reason: 'Itemumrechnung fehlt', usedInputs: 0, totalInputs: total };
    let sum = 0;
    let max = 0;
    let used = 0;
    values.forEach((v, i) => {
      if (v === undefined) return;
      sum += v;
      max += maxima[i]!;
      used++;
    });
    if (used < Math.min(16, total)) return { value: null, reason: `Zu wenige Angaben (${used} von ${total}; mindestens 16)`, usedInputs: used, totalInputs: total };
    return { value: roundHalfAwayFromZero((sum / max) * 100, 1), usedInputs: used, totalInputs: total };
  },
};

function koosSubscale(code: string, label: string): ScoreAlgorithmVersion {
  return {
    code,
    version: 1,
    name: `KOOS ${label} (Scoring – Freigabe ausstehend)`,
    description: '100 − (Mittelwert der Itemwerte 0–4 × 100 / 4); mindestens 50 % der Items der Subskala beantwortet.',
    unit: 'Punkte',
    range: [0, 100],
    direction: 'Höherer Wert = weniger Beschwerden',
    rounding: 'Eine Nachkommastelle, kaufmännisch',
    maxMissingShare: 0.5,
    inputScale: [0, 4],
    status: 'freigabe_ausstehend',
    quelle: 'Roos EM et al., J Orthop Sports Phys Ther 1998; KOOS User’s Guide – vor Freigabe gegen das Manual prüfen',
    compute(values) {
      const total = values.length;
      const valid = values.filter((v): v is number => typeof v === 'number' && v >= 0 && v <= 4);
      if (total === 0 || valid.length < Math.ceil(total * 0.5)) return { value: null, reason: `Zu wenige Angaben (${valid.length} von ${total}; mindestens 50 %)`, usedInputs: valid.length, totalInputs: total };
      const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
      return { value: roundHalfAwayFromZero(100 - (mean * 100) / 4, 1), usedInputs: valid.length, totalInputs: total };
    },
  };
}

export const KOOS_SUBSCALES = {
  'KOOS-SYMPTOME@1': koosSubscale('KOOS-SYMPTOME', 'Symptome'),
  'KOOS-SCHMERZ@1': koosSubscale('KOOS-SCHMERZ', 'Schmerz'),
  'KOOS-ADL@1': koosSubscale('KOOS-ADL', 'Alltagsaktivitäten'),
  'KOOS-SPORT@1': koosSubscale('KOOS-SPORT', 'Sport/Freizeit'),
  'KOOS-QOL@1': koosSubscale('KOOS-QOL', 'Lebensqualität'),
};

export const SCORE_REGISTRY: Record<string, ScoreAlgorithmVersion> = {
  'DEMO-SCORE@1': DEMO_SCORE_V1,
  'IKDC@1': IKDC_V1,
  ...KOOS_SUBSCALES,
};

export function getScoreAlgorithm(ref: string): ScoreAlgorithmVersion | undefined {
  return SCORE_REGISTRY[ref];
}
