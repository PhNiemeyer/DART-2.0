import { describe, expect, it } from 'vitest';
import {
  addMonths, addDays, localTimeToUtc, planEvents, reminderTimes, referenceDate, reminderIdempotencyKey, displayStatus,
  consentAllows, canTransition, requiredScopesForCase, checklistComplete,
  resolveQuestionnaires, hasPermission,
  csvCell, toCsv,
  normalizeLegacyRow, reconcile, sortByTimepoint, SYNTHETIC_MAPPING_V1, MigrationContext, mappingFromCatalog,
} from './index';

describe('Follow-up-Kalender', () => {
  it('rechnet Monatsende kalendarisch', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2026-03-15', 120)).toBe('2036-03-15');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('rechnet 09:00 Ortszeit sommerzeitfest in UTC um', () => {
    expect(localTimeToUtc('2026-01-15', 9).toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(localTimeToUtc('2026-07-15', 9).toISOString()).toBe('2026-07-15T07:00:00.000Z');
    // Umstellungstage
    expect(localTimeToUtc('2026-03-29', 9).toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(localTimeToUtc('2026-10-25', 9).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });
  it('Erinnerungen nach 7 und 12 Tagen über die Zeitumstellung', () => {
    const r = reminderTimes(new Date('2026-03-24T08:00:00Z'));
    expect(r.map((x) => x.at.toISOString())).toEqual(['2026-03-31T07:00:00.000Z', '2026-04-05T07:00:00.000Z']);
  });
  it('plant Baseline bis 60 Monate, 120 nur optional', () => {
    const ev = planEvents('2026-01-31');
    expect(ev.map((e) => e.timepoint)).toEqual(['BL', 'M6', 'M12', 'M24', 'M36', 'M60']);
    expect(ev[1].dueDate).toBe('2026-07-31');
    expect(planEvents('2026-01-31', undefined, true).at(-1)!.timepoint).toBe('M120');
  });
  it('trennt geplantes/tatsächliches OP-Datum und konservativen Beginn', () => {
    expect(referenceDate({ treatmentType: 'operativ', plannedOpDate: '2026-05-01' })).toEqual({ date: '2026-05-01', kind: 'op_geplant' });
    expect(referenceDate({ treatmentType: 'operativ', plannedOpDate: '2026-05-01', actualOpDate: '2026-05-03' }).kind).toBe('op_tatsaechlich');
    expect(referenceDate({ treatmentType: 'konservativ', plannedOpDate: '2026-05-01', conservativeStartDate: '2026-04-01' })).toEqual({ date: '2026-04-01', kind: 'konservativ' });
  });
  it('Idempotenzschlüssel und überfällig-Status', () => {
    expect(reminderIdempotencyKey({ caseId: 'c', eventId: 'e', ruleVersion: 'FU-PLAN-KNIE@1', stage: 'einladung' })).toBe('c:e:FU-PLAN-KNIE@1:einladung');
    expect(displayStatus('eingeladen', '2026-01-01', '2026-02-01')).toBe('ueberfaellig');
    expect(displayStatus('abgeschlossen', '2026-01-01', '2026-02-01')).toBe('abgeschlossen');
  });
});

describe('Einwilligung', () => {
  it('nur gültige Einwilligung mit vollem Umfang öffnet das Gate', () => {
    expect(consentAllows([], ['register_basic']).ok).toBe(false);
    expect(consentAllows([{ status: 'upload_in_pruefung', scopes: ['register_basic'] }], ['register_basic']).ok).toBe(false);
    expect(consentAllows([{ status: 'abgelehnt', scopes: ['register_basic'] }], ['register_basic']).reason).toMatch(/Abgelehnt/);
    expect(consentAllows([{ status: 'historisch_ungeklaert', scopes: ['register_basic'] }], ['register_basic']).ok).toBe(false);
    expect(consentAllows([{ status: 'gueltig', scopes: ['register_basic'] }], ['register_basic', 'science']).ok).toBe(false);
    expect(consentAllows([{ status: 'gueltig', scopes: ['register_basic', 'science'] }], ['register_basic', 'science']).ok).toBe(true);
  });
  it('Zustandsautomat verbietet direkte Sprünge', () => {
    expect(canTransition('fehlt', 'gueltig')).toBe(false);
    expect(canTransition('upload_in_pruefung', 'gueltig')).toBe(true);
    expect(canTransition('widerrufen', 'gueltig')).toBe(false);
    expect(canTransition('historisch_ungeklaert', 'gueltig')).toBe(false);
  });
  it('Scopes je Modus/Register und Prüfliste', () => {
    expect(requiredScopesForCase('science', ['DART', 'KNORPEL_DGOU', 'DEKOR'])).toEqual(['register_basic', 'science', 'knorpelregister', 'dekor']);
    expect(checklistComplete({ richtige_person: true, vollstaendig: true, richtige_version: true })).toBe(false);
  });
});

describe('Zuordnungsmatrix und Rechte', () => {
  it('Basis erscheint bei Knorpel + Osteotomie nur einmal; Basic ≠ Science-BA', () => {
    const q = resolveQuestionnaires({ joint: 'knie', mode: 'science', treatment: 'operativ', registers: ['DART', 'KNORPEL_DGOU', 'DEKOR'], modules: ['KNORPEL', 'OSTEOTOMIE'] }, 'arzt', 'BL');
    expect(q.map((x) => x.questionnaire)).toEqual(['KNIE-BA-ARZT', 'KNIE-KNORPEL-ARZT', 'DEKOR-OSTEOTOMIE-ARZT']);
    const b = resolveQuestionnaires({ joint: 'knie', mode: 'basic', treatment: 'operativ', registers: ['DART'], modules: [] }, 'arzt', 'BL');
    expect(b.map((x) => x.questionnaire)).toEqual(['KNIE-BASIC-ARZT']);
  });
  it('Technischer Betrieb ohne fachliche Rechte; Redaktion darf nicht veröffentlichen', () => {
    expect(hasPermission(['technik'], 'case.read')).toBe(false);
    expect(hasPermission(['formularredaktion'], 'form.publish')).toBe(false);
    expect(hasPermission(['dokumentation'], 'case.finalize')).toBe(false);
  });
});

describe('CSV', () => {
  it('verhindert Formelinjektion', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+49')).toBe("'+49");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(toCsv(['a'], [{ a: 1 }])).toBe('a\r\n1\r\n');
  });
});

describe('Migration (synthetisch)', () => {
  const ctx: MigrationContext = { sourceSystem: 'DART-ALT-SYNTH', exportVersion: 'SYNTH-1', mapping: SYNTHETIC_MAPPING_V1, centerMap: { '101': 'center-a' }, maxPlausibleYear: 2027 };
  const base = { P_ID: '5001', ZENTRUM: '101', VISITCODE: '1', BASELINE_DATE: '15.03.2024', SEITE: '1' };
  it('P_ID ist Beleg-ID; 999 ist kein Zentrum', () => {
    const r = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { ...base, ZENTRUM: '999' } }, ctx);
    expect(r.outcome).toBe('ungeklaert');
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['PID_IST_BELEG_ID', 'ZENTRUM_999']));
    expect(r.centerId).toBeNull();
  });
  it('BASELINE_DATE = OP-Datum, Visitcode 8 = FU3, Sortierung nach Codeliste', () => {
    const r = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { ...base, VISITCODE: '8' } }, ctx);
    expect(r.opDate).toBe('2024-03-15');
    expect(r.timepoint).toBe('FU3');
    const sorted = sortByTimepoint([{ visitCode: '4' }, { visitCode: '8' }, { visitCode: '1' }], SYNTHETIC_MAPPING_V1);
    expect(sorted.map((x) => x.visitCode)).toEqual(['1', '8', '4']);
  });
  it('leere Checkbox ≠ 0; 0 bleibt nein', () => {
    const r = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { ...base, RAUCHER_CB: '' } }, ctx);
    const v = r.values.find((x) => x.column === 'RAUCHER_CB')!;
    expect(v.normalized).toBeNull();
    expect(v.outcome).toBe('ungeklaert');
    expect(v.raw).toBe('');
    const r0 = normalizeLegacyRow({ sheet: 'CA', sourceRow: 3, cells: { ...base, RAUCHER_CB: '0' } }, ctx);
    expect(r0.values.find((x) => x.column === 'RAUCHER_CB')!.normalized).toBe('nein');
  });
  it('Alias-Abweichung, doppelte VARID, fehlende VARID, unplausibles Datum, umbenannte Variable', () => {
    const r = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { ...base, CA_VAS: '4,5', VOROP_A: '1', FREITEXT_ALT: 'x', BASELINE_DATE: '24.04.3023', FU_ERNEUTOP: '1' } }, ctx);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['ALIAS_ABWEICHUNG', 'VARID_MEHRFACH', 'VARID_FEHLT', 'DATUM_UNPLAUSIBEL', 'SPALTE_UNGEMAPPT']));
    expect(r.values.find((v) => v.column === 'CA_VAS')!.normalized).toBe(4.5);
    expect(r.opDate).toBeNull();
  });
  it('gleiche OPS mit unterschiedlichem Konzept; unbekannte Exportversion → Quarantäne', () => {
    const g = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { ...base, OPS1: '5-812', OPS1_ART: 'G' } }, ctx);
    const t = normalizeLegacyRow({ sheet: 'CA', sourceRow: 3, cells: { ...base, OPS1: '5-812', OPS1_ART: 'T' } }, ctx);
    expect(g.procedures[0].concept).toBe('KNORPEL_GLAETTUNG');
    expect(t.procedures[0].concept).toBe('MENISKUS_TEILRESEKTION');
    const n = normalizeLegacyRow({ sheet: 'CA', sourceRow: 4, cells: { ...base, OPS1: '5-812' } }, ctx);
    expect(n.issues.some((i) => i.code === 'OPS_KONZEPT_MEHRDEUTIG')).toBe(true);
    const q = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: base }, { ...ctx, exportVersion: 'X' });
    expect(q.outcome).toBe('quarantaene');
    expect(q.values.length).toBe(Object.keys(base).length);
  });
  it('Bilanz geht auf', () => {
    expect(reconcile(['normalisiert', 'archiviert', 'ungeklaert', 'quarantaene', 'normalisiert'])).toMatchObject({ geliefert: 5, normalisiert: 2, ausgeglichen: true });
  });
});

import { ageGroup, compare, tQuantile975 } from './index';
describe('Autoreport-Hilfen', () => {
  it('Altersgruppen zum Bezugsdatum', () => {
    expect(ageGroup('1980-06-15', '2026-06-14')).toBe('45–49');
    expect(ageGroup('1980-06-15', '2026-06-15')).toBe('45–49');
    expect(ageGroup('1981-06-16', '2026-06-15')).toBe('40–44');
    expect(ageGroup('2010-01-01', '2026-01-01')).toBe('<18');
    expect(ageGroup('1930-01-01', '2026-01-01')).toBe('85+');
    expect(ageGroup('x', '2026-01-01')).toBeNull();
  });
  it('t-Quantile und Einordnung der Abweichung', () => {
    expect(tQuantile975(9)).toBeCloseTo(2.262, 3);
    expect(tQuantile975(1000)).toBeCloseTo(1.962, 2);
    // n=25, sd=10 → Halbbreite 2,064·2 = 4,13
    expect(compare({ n: 25, mean: 80, sd: 10 }, { n: 500, mean: 70, sd: 12 })).toMatchObject({ diff: 10, einordnung: 'ueber' });
    expect(compare({ n: 25, mean: 72, sd: 10 }, { n: 500, mean: 70, sd: 12 }).einordnung).toBe('im_bereich');
    expect(compare({ n: 25, mean: 60, sd: 10 }, { n: 500, mean: 70, sd: 12 }).einordnung).toBe('unter');
    expect(compare({ n: 4, mean: 60, sd: 10 }, { n: 500, mean: 70, sd: 12 }).einordnung).toBe('zu_wenige_faelle');
  });
});

describe('Katalog-Mapping V05 (ohne Freigabe)', () => {
  const cat = [
    { sheet: 'CA', sourceRow: 2, altName: 'P_ID', sasAlias: 'P_ID', varId: 'CA001', dartId: 'CA001', klasse: 'Überarbeitung', klasseCode: 'B' as const, label: '', vergleichbarkeit: '', basicScience: '', pruefhinweise: [], entscheidung: 'Vorschlag; fachlich offen', freigabeDurch: null, altformat: '', codeliste: '' },
    { sheet: 'CA', sourceRow: 6, altName: 'CA_SEX', sasAlias: 'CA_SEX', varId: 'CA005', dartId: 'CA005', klasse: 'Entfall', klasseCode: 'C' as const, label: '', vergleichbarkeit: '', basicScience: '', pruefhinweise: [], entscheidung: 'Vorschlag; fachlich offen', freigabeDurch: null, altformat: '', codeliste: '' },
    { sheet: 'CA', sourceRow: 9, altName: 'CA_X-1', sasAlias: 'CA_X_1', varId: 'CA009', dartId: null, klasse: 'Übernahme', klasseCode: 'A' as const, label: '', vergleichbarkeit: '', basicScience: '', pruefhinweise: ['Leere Checkbox nicht automatisch 0', 'eCRF-/SAS-Alias abweichend'], entscheidung: 'Vorschlag; fachlich offen', freigabeDurch: null, altformat: '', codeliste: '' },
  ];
  const mapping = mappingFromCatalog(cat);
  const ctx = { sourceSystem: 'DART-KNIE-PROD', exportVersion: 'V05', mapping, centerMap: {} };
  it('ohne Freigabe wird nichts normalisiert; Rohwerte bleiben, Entfall archiviert', () => {
    const r = normalizeLegacyRow({ sheet: 'CA', sourceRow: 2, cells: { P_ID: '77', CA_SEX: '1', CA_X_1: '', UNBEKANNT: 'x' } }, ctx);
    expect(r.outcome).toBe('ungeklaert');
    expect(r.recordId).toBe('77');
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['MAPPING_NICHT_FREIGEGEBEN', 'ALIAS_ABWEICHUNG', 'CHECKBOX_LEER', 'SPALTE_UNGEMAPPT']));
    expect(r.values.find((v) => v.column === 'CA_SEX')!.outcome).toBe('archiviert');
    expect(r.values.find((v) => v.column === 'CA_X_1')!.outcome).toBe('ungeklaert');
    expect(r.values).toHaveLength(4);
  });
});
