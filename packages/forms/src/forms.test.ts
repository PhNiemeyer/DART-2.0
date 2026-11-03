import { describe, expect, it } from 'vitest';
import { DEMO_SCORE_V1, evaluateForm, evaluateRule, FormSchema, validateSchema, blockingIssues, canonicalJson } from './index';

const schema: FormSchema = {
  schemaVersion: 1,
  code: 'TEST',
  title: 'Testbogen',
  audience: 'arzt',
  module: 'BASIS',
  sections: [
    {
      id: 's1',
      title: 'Allgemein',
      items: [
        { id: 'therapie', varId: 'T_THERAPIE', label: 'Therapie', type: 'single', required: true, codes: [{ code: 'op', label: 'Operativ' }, { code: 'kons', label: 'Konservativ' }] },
        { id: 'winkel', varId: 'T_WINKEL', label: 'Winkel', type: 'number', unit: 'Grad', min: 0, max: 180, decimals: 1, required: true, visibleIf: { eq: [{ var: 'therapie' }, 'op'] } },
        { id: 'grund', varId: 'T_GRUND', label: 'Begründung', type: 'text', visibleIf: { gt: [{ var: 'winkel' }, 90] } },
        { id: 'q1', varId: 'T_Q1', label: 'Frage 1', type: 'single', codes: ['0', '1', '2', '3', '4'].map((c) => ({ code: c, label: c })) },
        { id: 'q2', varId: 'T_Q2', label: 'Frage 2', type: 'single', codes: ['0', '1', '2', '3', '4'].map((c) => ({ code: c, label: c })), visibleIf: { eq: [{ var: 'therapie' }, 'op'] } },
        { id: 'score', varId: 'T_SCORE', label: 'Demonstrationsscore', type: 'computed', compute: { algorithm: 'DEMO-SCORE@1', inputs: ['q1', 'q2'] } },
        {
          id: 'defekte', varId: 'T_DEFEKTE', label: 'Defekte', type: 'group', repeat: { min: 1, max: 3, instanceLabel: 'Defekt' },
          items: [
            { id: 'def_lok', varId: 'T_DEF_LOK', label: 'Lokalisation', type: 'single', required: true, codes: [{ code: 'mfc', label: 'MFC' }, { code: 'lfc', label: 'LFC' }] },
            { id: 'def_groesse', varId: 'T_DEF_GR', label: 'Größe', type: 'number', unit: 'cm²', required: true, visibleIf: { eq: [{ var: 'def_lok' }, 'mfc'] }, allowedMissing: ['nicht_erhoben'] },
          ],
        },
      ],
    },
  ],
};

describe('Regel-DSL', () => {
  const r = (m: Record<string, unknown>) => (n: string) => m[n];
  it('wertet Whitelist-Operatoren aus', () => {
    expect(evaluateRule({ all: [{ eq: [{ var: 'a' }, 1] }, { in: [{ var: 'b' }, ['x', 'y']] }] }, r({ a: 1, b: 'y' }))).toBe(true);
    expect(evaluateRule({ any: [{ eq: [{ var: 'a' }, 2] }, { not: { exists: 'c' } }] }, r({ a: 1 }))).toBe(true);
    expect(evaluateRule({ gte: [{ var: 'a' }, 5] }, r({ a: 5 }))).toBe(true);
    expect(evaluateRule({ lt: [{ var: 'a' }, 5] }, r({}))).toBe(false);
    expect(evaluateRule({ in: [{ var: 'm' }, ['k']] }, r({ m: ['j', 'k'] }))).toBe(true);
    expect(evaluateRule({ lte: [{ var: 'd' }, '2026-01-01'] }, r({ d: '2025-12-31' }))).toBe(true);
  });
  it('lehnt unbekannte Operatoren ab (kein eval)', () => {
    expect(() => evaluateRule({ eval: 'process.exit()' } as never, () => undefined)).toThrow(/Unzulässiger Regeloperator/);
  });
});

describe('Schemaprüfung', () => {
  it('akzeptiert gültiges Schema', () => {
    expect(validateSchema(schema)).toEqual([]);
  });
  it('erkennt Zyklen', () => {
    const s: FormSchema = JSON.parse(JSON.stringify(schema));
    s.sections[0].items[0].visibleIf = { exists: 'grund' };
    const errs = validateSchema(s).map((e) => e.message).join('\n');
    expect(errs).toMatch(/Zyklische Abhängigkeit/);
  });
  it('erkennt ungültige Referenzen und Typfehler', () => {
    const s: FormSchema = JSON.parse(JSON.stringify(schema));
    s.sections[0].items[1].visibleIf = { eq: [{ var: 'therapie' }, 'gibtsnicht'] };
    s.sections[0].items[2].visibleIf = { gt: [{ var: 'therapie' }, 3] };
    s.sections[0].items[3].visibleIf = { exists: 'unbekannt' };
    const msgs = validateSchema(s).map((e) => e.message);
    expect(msgs.some((m) => m.includes('nicht definiert'))).toBe(true);
    expect(msgs.some((m) => m.includes('nicht-numerischem'))).toBe(true);
    expect(msgs.some((m) => m.includes('unbekanntes Feld'))).toBe(true);
  });
  it('verbietet Verweise in wiederholbare Gruppen von außen und unbekannte Feldtypen', () => {
    const s: FormSchema = JSON.parse(JSON.stringify(schema));
    s.sections[0].items[2].visibleIf = { exists: 'def_lok' };
    (s.sections[0].items[3] as { type: string }).type = 'signatur';
    const msgs = validateSchema(s).map((e) => e.message).join('\n');
    expect(msgs).toMatch(/Unbekannter Feldtyp/);
  });
  it('kanonisches JSON ist schlüsselsortiert', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}');
  });
});

describe('Formularauswertung', () => {
  it('blendet aus, erhält aber ausgeblendete Antworten als inaktiv und nimmt sie nicht in Scores', () => {
    const ev = evaluateForm(schema, {
      answers: { therapie: { value: 'kons' }, winkel: { value: 120 }, q1: { value: '4' }, q2: { value: '0' }, 'defekte[a1].def_lok': { value: 'lfc' } },
      instances: { defekte: ['a1'] },
    });
    expect(ev.visibleKeys).not.toContain('winkel');
    expect(ev.inactiveKeys).toEqual(expect.arrayContaining(['winkel', 'q2']));
    // q2 inaktiv → Score nur aus q1 (1 von 2 fehlt = 50 % zulässig)
    expect(ev.scores[0].value).toBe(100);
    expect(blockingIssues(ev)).toEqual([]);
  });
  it('prüft Pflicht, Bereich, Nachkommastellen, Gruppen und Fehlgründe', () => {
    const ev = evaluateForm(schema, {
      answers: { therapie: { value: 'op' }, winkel: { value: 200.25 }, 'defekte[x].def_lok': { value: 'mfc' }, 'defekte[x].def_groesse': { missing: 'verweigert' } },
      instances: { defekte: ['x'] },
    });
    const msgs = ev.issues.map((i) => `${i.key}: ${i.message}`);
    expect(msgs.some((m) => m.startsWith('winkel') && m.includes('Maximum'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('winkel') && m.includes('Nachkommastelle'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('defekte[x].def_groesse') && m.includes('nicht zulässig'))).toBe(true);
    const ev2 = evaluateForm(schema, { answers: { therapie: { value: 'kons' } }, instances: {} });
    expect(ev2.issues.some((i) => i.kind === 'gruppe')).toBe(true);
  });
  it('fehlende Pflichtangaben zählen im Fortschritt', () => {
    const ev = evaluateForm(schema, { answers: { therapie: { value: 'op' } }, instances: { defekte: [] } });
    expect(ev.progress.total).toBeGreaterThan(ev.progress.answered);
    expect(ev.issues.some((i) => i.key === 'winkel' && i.kind === 'pflicht')).toBe(true);
  });
});

describe('Demonstrationsscore DEMO-SCORE@1 (bekannte Testwerte)', () => {
  const cases: Array<[Array<number | undefined>, number | null]> = [
    [[4, 4, 4, 4], 100],
    [[0, 2, 4, 2], 50],
    [[1, 2, 3, undefined], 50],
    [[3, 3, 4, 4], 87.5],
    [[1, 1, 2, undefined], 33.3],
    [[1, undefined, undefined, undefined], null],
    [[0, 0, undefined, undefined], 0],
  ];
  it.each(cases)('%j → %s', (input, expected) => {
    expect(DEMO_SCORE_V1.compute(input).value).toBe(expected);
  });
});

describe('Prüfregeln dürfen das eigene Feld referenzieren', () => {
  it('Selbstbezug in validations ist erlaubt, in visibleIf nicht', () => {
    const s: FormSchema = { schemaVersion: 1, code: 'T2', title: 'T', audience: 'arzt', module: 'B', sections: [{ id: 's', title: 'S', items: [
      { id: 'x', varId: 'X', label: 'X', type: 'number', validations: [{ rule: { lte: [{ var: 'x' }, 5] }, message: 'zu hoch', severity: 'hinweis' }] },
    ] }] };
    expect(validateSchema(s)).toEqual([]);
    const ev = evaluateForm(s, { answers: { x: { value: 9 } }, instances: {} });
    expect(ev.issues[0]).toMatchObject({ message: 'zu hoch', severity: 'hinweis' });
    expect(blockingIssues(ev)).toEqual([]);
    s.sections[0].items[0].visibleIf = { exists: 'x' };
    expect(validateSchema(s).some((e) => e.message.includes('sich selbst'))).toBe(true);
  });
});

import { formatGermanDate, parseGermanDate } from './index';
describe('Deutsche Datumseingabe', () => {
  it.each([
    ['01.02.2026', '2026-02-01'], ['1.2.2026', '2026-02-01'], ['01022026', '2026-02-01'], ['2026-02-01', '2026-02-01'],
    ['29.02.2028', '2028-02-29'], [' 31.12.2026 ', '2026-12-31'], ['', ''],
  ])('%s → %s', (i, o) => expect(parseGermanDate(i)).toBe(o));
  it.each(['29.02.2026', '31.04.2026', '1.2.26', '01.13.2026', '00.01.2026', '12/01/2026', 'morgen'])('%s ist ungültig', (i) => expect(parseGermanDate(i)).toBeNull());
  it('formatiert ISO als TT.MM.JJJJ', () => {
    expect(formatGermanDate('2026-02-01')).toBe('01.02.2026');
    expect(formatGermanDate(null)).toBe('');
  });
});

import { IKDC_V1, KOOS_SUBSCALES } from './index';
describe('IKDC und KOOS (Scoring, Freigabe ausstehend)', () => {
  const maxIkdc = [4, 10, 10, 4, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 10];
  it('IKDC: Maximalsumme 87; bestes Ergebnis 100, schlechtestes 0, Teilantworten auf beantwortete Items bezogen', () => {
    expect(maxIkdc.reduce((a, b) => a + b, 0)).toBe(87);
    expect(IKDC_V1.compute(maxIkdc, maxIkdc).value).toBe(100);
    expect(IKDC_V1.compute(maxIkdc.map(() => 0), maxIkdc).value).toBe(0);
    const half = maxIkdc.map((m) => m / 2);
    expect(IKDC_V1.compute(half, maxIkdc).value).toBe(50);
    const twoMissing = [...maxIkdc.slice(0, 16), undefined, undefined];
    expect(IKDC_V1.compute(twoMissing, maxIkdc).value).toBe(100);
    const threeMissing = [...maxIkdc.slice(0, 15), undefined, undefined, undefined];
    expect(IKDC_V1.compute(threeMissing, maxIkdc).value).toBeNull();
  });
  it('KOOS: 0 = keine Beschwerden → 100; 4 → 0; Mittelwert 1 → 75; < 50 % Angaben → kein Wert', () => {
    const s = KOOS_SUBSCALES['KOOS-QOL@1'];
    expect(s.compute([0, 0, 0, 0]).value).toBe(100);
    expect(s.compute([4, 4, 4, 4]).value).toBe(0);
    expect(s.compute([1, 1, 1, 1]).value).toBe(75);
    expect(s.compute([2, 1, undefined, undefined]).value).toBe(62.5);
    expect(s.compute([2, undefined, undefined, undefined]).value).toBeNull();
  });
  it('Umrechnung im Formular: umgekehrte Items (z. B. KOOS S4) und Verschiebung (IKDC 1–5 → 0–4)', () => {
    const schema: FormSchema = { schemaVersion: 1, code: 'T3', title: 'T', audience: 'patient', module: 'B', sections: [{ id: 's', title: 'S', items: [
      { id: 'a', varId: 'A', label: 'A', type: 'single', codes: ['0', '1', '2', '3', '4'].map((c) => ({ code: c, label: c })) },
      { id: 'b', varId: 'B', label: 'B', type: 'single', codes: ['0', '1', '2', '3', '4'].map((c) => ({ code: c, label: c })) },
      { id: 'k', varId: 'K', label: 'K', type: 'computed', compute: { algorithm: 'KOOS-SYMPTOME@1', inputs: ['a', 'b'], transforms: { b: { min: 0, max: 4, reverse: true } } } },
    ] }] };
    expect(validateSchema(schema)).toEqual([]);
    // a = 0 (keine Beschwerden), b = 4 („immer ganz strecken“ = gut) → umgekehrt 0 → 100
    expect(evaluateForm(schema, { answers: { a: { value: '0' }, b: { value: '4' } }, instances: {} }).scores[0].value).toBe(100);
  });
});
