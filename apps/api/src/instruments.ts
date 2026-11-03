import { Code, FormItem, FormSchema } from '@dart/forms';

/**
 * Patientenbögen IKDC und KOOS, abgeleitet aus dem Variablenkatalog V05 (Blätter IK und KO).
 * Fragetexte und Codes stammen aus der Quelle (teils verkürzt); die validierte Originalformulierung und die
 * Lizenz sind vor Freigabe zu prüfen (Lastenheft E-09). Keine erfundenen Inhalte.
 */
interface CatalogRow {
  sheet: string;
  altName: string;
  varId: string | null;
  klasseCode: string;
  label: string;
  codeliste: string;
}

const TECHNICAL = new Set(['P_ID', 'BASELINE_DATE']);
const isTechnical = (n: string) => TECHNICAL.has(n) || /_(PAT_NUM|VISIT_NUM|SITE_NUM|P_D|USER|VISIT_PLAN)$/.test(n);

export function parseCodelist(raw: string): Code[] {
  const s = raw.replace(/\r/g, '').trim();
  if (!s) return [];
  // Skalen der Form „0=nie bis ; 10=immer“
  if (/\bbis\b/.test(s)) {
    const ends = [...s.matchAll(/(\d+)\s*=\s*([^;\n]+?)(?:\s*bis\s*)?(?=;|\n|$)/g)].map((m) => ({ n: Number(m[1]), t: m[2].replace(/\s*bis\s*$/, '').trim() }));
    if (ends.length >= 2) {
      const lo = Math.min(...ends.map((e) => e.n));
      const hi = Math.max(...ends.map((e) => e.n));
      const label = (n: number) => ends.find((e) => e.n === n)?.t;
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((n) => ({ code: String(n), label: label(n) ? `${n} – ${label(n)}` : String(n) }));
    }
  }
  return s
    .split(/[;\n]/)
    .map((p) => /^\s*(\d+)\s*=\s*(.+?)\s*$/.exec(p))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ code: m[1], label: m[2] }));
}

const idOf = (altName: string) => altName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const cleanLabel = (l: string) => l.replace(/\s*\((IK|KO)\)\s*$/, '').trim();

function item(r: CatalogRow): FormItem {
  return {
    id: idOf(r.altName),
    varId: r.varId ?? `${r.sheet}:${r.altName}`,
    label: cleanLabel(r.label),
    type: 'single',
    required: true,
    allowedMissing: ['verweigert'],
    codes: parseCodelist(r.codeliste),
  };
}

function range(it: FormItem): { min: number; max: number } {
  const n = (it.codes ?? []).map((c) => Number(c.code));
  return { min: Math.min(...n), max: Math.max(...n) };
}

/** IKDC: 18 bewertete Items; Schmerzhäufigkeit/-stärke und „gesperrtes Knie“ umgekehrt; Item 10a nicht bewertet. */
export function buildIkdcForm(catalog: CatalogRow[]): FormSchema {
  const rows = catalog.filter((r) => r.sheet === 'IK' && !isTechnical(r.altName) && r.klasseCode !== 'C');
  const items = rows.map(item);
  const byName = new Map(rows.map((r, i) => [r.altName, items[i]]));
  const reverse = new Set(['IK_PAIN', 'IK_PAIN_SEV', 'IK_MOTILITY_YN']);
  const scored = rows.map((r) => r.altName).filter((n) => n !== 'IK_FUNC');
  const transforms: Record<string, { min: number; max: number; reverse?: boolean }> = {};
  for (const n of scored) {
    const it = byName.get(n)!;
    transforms[it.id] = { ...range(it), reverse: reverse.has(n) || undefined };
  }
  const pick = (pred: (n: string) => boolean) => rows.filter((r) => pred(r.altName)).map((r) => byName.get(r.altName)!);
  return {
    schemaVersion: 1,
    code: 'KNIE-IKDC',
    title: 'IKDC – Subjektive Beurteilung des Knies',
    audience: 'patient',
    module: 'BASIS',
    description: 'Aus DART-Datenbankbeschreibung V05 (Blatt IK) abgeleitet. Scoring: Freigabe ausstehend (E-09).',
    sections: [
      { id: 'symptome', title: 'Symptome', items: pick((n) => /^IK_(ACTIV_MAX[123]|PAIN|PAIN_SEV|KNEE_SWOLLEN|MOTILITY_YN)$/.test(n)) },
      { id: 'aktivitaeten', title: 'Sportliche Aktivitäten', items: pick((n) => /^IK_(ACTIV_MAX4|ACTION\d+(_NEU)?)$/.test(n)) },
      { id: 'funktion', title: 'Funktion', items: pick((n) => /^IK_FUNCA?$/.test(n)) },
      {
        id: 'ergebnis',
        title: 'Ergebnis',
        items: [{ id: 'ikdc_score', varId: 'DART_IKDC_SCORE', label: 'IKDC-Score (Freigabe ausstehend)', type: 'computed', unit: 'Punkte', compute: { algorithm: 'IKDC@1', inputs: scored.map((n) => byName.get(n)!.id), transforms } }],
      },
    ],
  };
}

/** KOOS: fünf Subskalen; S4/S5 („Knie ganz ausstrecken/beugen“, 4 = immer) werden umgekehrt. */
export function buildKoosForm(catalog: CatalogRow[]): FormSchema {
  const rows = catalog.filter((r) => r.sheet === 'KO' && !isTechnical(r.altName) && r.klasseCode !== 'C');
  const groups: Array<{ id: string; title: string; prefix: RegExp; alg: string; label: string }> = [
    { id: 'symptome', title: 'Symptome und Steifigkeit', prefix: /^KO_S\d+$/, alg: 'KOOS-SYMPTOME@1', label: 'KOOS Symptome' },
    { id: 'schmerz', title: 'Schmerz', prefix: /^KO_P\d+$/, alg: 'KOOS-SCHMERZ@1', label: 'KOOS Schmerz' },
    { id: 'alltag', title: 'Aktivitäten des täglichen Lebens', prefix: /^KO_A\d+$/, alg: 'KOOS-ADL@1', label: 'KOOS Alltag' },
    { id: 'sport', title: 'Sport und Freizeit', prefix: /^KO_SP\d+$/, alg: 'KOOS-SPORT@1', label: 'KOOS Sport/Freizeit' },
    { id: 'lebensqualitaet', title: 'Lebensqualität', prefix: /^KO_Q\d+$/, alg: 'KOOS-QOL@1', label: 'KOOS Lebensqualität' },
  ];
  const reverse = new Set(['KO_S4', 'KO_S5']);
  return {
    schemaVersion: 1,
    code: 'KNIE-KOOS',
    title: 'KOOS – Knee injury and Osteoarthritis Outcome Score',
    audience: 'patient',
    module: 'BASIS',
    description: 'Aus DART-Datenbankbeschreibung V05 (Blatt KO) abgeleitet; Fragetexte in der Quelle verkürzt. Scoring: Freigabe ausstehend (E-09).',
    sections: groups.map((g) => {
      const gr = rows.filter((r) => g.prefix.test(r.altName));
      const its = gr.map(item);
      const transforms: Record<string, { min: number; max: number; reverse?: boolean }> = {};
      gr.forEach((r, i) => {
        if (reverse.has(r.altName)) transforms[its[i].id] = { min: 0, max: 4, reverse: true };
      });
      return {
        id: g.id,
        title: g.title,
        items: [
          ...its,
          { id: `koos_${g.id}`, varId: `DART_${g.alg.replace('@1', '').replace(/-/g, '_')}`, label: `${g.label} (Freigabe ausstehend)`, type: 'computed' as const, unit: 'Punkte', compute: { algorithm: g.alg, inputs: its.map((x) => x.id), transforms: Object.keys(transforms).length ? transforms : undefined } },
        ],
      };
    }),
  };
}
