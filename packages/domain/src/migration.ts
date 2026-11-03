/**
 * Historische Migration (M03–M06): Normalisierung einzelner Altdatensätze.
 * Grundsätze: nichts still reparieren, Rohwerte unverändert erhalten, jede Zeile
 * genau einmal bilanzieren (normalisiert | archiviert | ungeklärt | Quarantäne).
 */

export type Comparability = 'direkt' | 'transformiert' | 'nicht_vergleichbar' | 'ungeklaert';
export type RowOutcome = 'normalisiert' | 'archiviert' | 'ungeklaert' | 'quarantaene';
export type ValueOutcome = 'normalisiert' | 'archiviert' | 'ungeklaert';

export const ROW_OUTCOME_LABELS: Record<RowOutcome, string> = {
  normalisiert: 'Normalisiert',
  archiviert: 'Bewusst historisch archiviert',
  ungeklaert: 'Gesichert, ungeklärt',
  quarantaene: 'Quarantäne',
};

export type TargetSpec =
  | { kind: 'record_id' }
  | { kind: 'center' }
  | { kind: 'visit' }
  | { kind: 'op_date' }
  | { kind: 'side' }
  | { kind: 'variable'; concept: string; type: 'code' | 'number' | 'date' | 'text' | 'checkbox' }
  | { kind: 'ops'; conceptColumn?: string }
  | { kind: 'archive' }
  /** Zielkonzept nicht freigegeben: Rohwert sichern, als ungeklärt kennzeichnen. */
  | { kind: 'offen'; checkbox?: boolean };

export interface MappingEntry {
  sheet: string;
  /** Spaltenname im Export (eCRF-/Altname). */
  column: string;
  varId: string | null;
  dartId?: string;
  sasAlias?: string;
  /** A=Übernahme, B=Überarbeitung, C=Entfall (nur historisch), D=Neuanlage */
  classification: 'A' | 'B' | 'C' | 'D';
  target: TargetSpec;
  codeMap?: Record<string, string>;
  status: 'vorschlag' | 'freigegeben';
}

export interface MappingRuleVersion {
  code: string;
  version: number;
  /** Ohne Freigabe werden „offene“ Ziele nie normalisiert. */
  status?: 'vorschlag' | 'freigegeben';
  sourceSystem: string;
  exportVersions: string[];
  /** Codeliste Visitcode → Zeitpunkt (nicht numerisch sortieren!). */
  visitCodes: Record<string, { timepoint: string; order: number }>;
  entries: MappingEntry[];
}

export interface LegacyRowInput {
  sheet: string;
  sourceRow: number;
  cells: Record<string, string>;
}

export interface MigrationContext {
  sourceSystem: string;
  exportVersion: string;
  mapping: MappingRuleVersion;
  /** Bestätigte Zuordnung Alt-Zentrumscode → Zielzentrum. 999 ist NIE bestätigt. */
  centerMap: Record<string, string>;
  maxPlausibleYear?: number;
}

export interface MigrationIssue {
  code: string;
  message: string;
  column?: string;
  blocking: boolean;
}

export interface NormalizedValue {
  column: string;
  sourceKey: string;
  varId: string | null;
  concept: string | null;
  raw: string;
  normalized: string | number | null;
  comparability: Comparability;
  outcome: ValueOutcome;
}

export interface NormalizedRow {
  outcome: RowOutcome;
  recordId: string | null;
  centerCode: string | null;
  centerId: string | null;
  opDate: string | null;
  timepoint: string | null;
  side: string | null;
  procedures: Array<{ code: string; concept: string | null }>;
  issues: MigrationIssue[];
  values: NormalizedValue[];
}

function plausibleDate(raw: string, maxYear: number): { iso: string | null; reason?: string } {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw.trim()) ?? null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
  else if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return { iso: null, reason: 'Datumsformat nicht erkannt' };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { iso: null, reason: 'Ungültiges Kalenderdatum' };
  if (y < 1900 || y > maxYear) return { iso: null, reason: `Unplausibles Jahr ${y}` };
  return { iso: `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** Liefert für eine Spalte den Mappingeintrag (Spaltenname oder SAS-Alias), niemals VARID-only. */
export function findEntry(mapping: MappingRuleVersion, sheet: string, column: string): { entry?: MappingEntry; viaAlias: boolean; ambiguous: MappingEntry[] } {
  const inSheet = mapping.entries.filter((e) => e.sheet === sheet);
  const direct = inSheet.filter((e) => e.column === column);
  if (direct.length === 1) return { entry: direct[0], viaAlias: false, ambiguous: [] };
  if (direct.length > 1) return { viaAlias: false, ambiguous: direct };
  const alias = inSheet.filter((e) => e.sasAlias === column);
  if (alias.length === 1) return { entry: alias[0], viaAlias: true, ambiguous: [] };
  if (alias.length > 1) return { viaAlias: true, ambiguous: alias };
  return { viaAlias: false, ambiguous: [] };
}

export function normalizeLegacyRow(row: LegacyRowInput, ctx: MigrationContext): NormalizedRow {
  const issues: MigrationIssue[] = [];
  const values: NormalizedValue[] = [];
  const maxYear = ctx.maxPlausibleYear ?? new Date().getUTCFullYear() + 1;
  const out: NormalizedRow = {
    outcome: 'normalisiert',
    recordId: null,
    centerCode: null,
    centerId: null,
    opDate: null,
    timepoint: null,
    side: null,
    procedures: [],
    issues,
    values,
  };

  if (ctx.sourceSystem !== ctx.mapping.sourceSystem || !ctx.mapping.exportVersions.includes(ctx.exportVersion)) {
    issues.push({ code: 'EXPORTVERSION_UNBEKANNT', message: `Quellsystem/Exportversion „${ctx.sourceSystem} ${ctx.exportVersion}“ ist in Mappingversion ${ctx.mapping.version} nicht beschrieben`, blocking: true });
    out.outcome = 'quarantaene';
    for (const [column, raw] of Object.entries(row.cells)) {
      values.push({ column, sourceKey: `${row.sheet}:${column}`, varId: null, concept: null, raw, normalized: null, comparability: 'ungeklaert', outcome: 'ungeklaert' });
    }
    return out;
  }

  // Mehrfache VARID im Blatt erkennen (Mapping-Ebene)
  const varIdCount = new Map<string, number>();
  for (const e of ctx.mapping.entries.filter((x) => x.sheet === row.sheet && x.varId)) varIdCount.set(e.varId!, (varIdCount.get(e.varId!) ?? 0) + 1);

  let allArchive = true;
  let openColumns = 0;
  for (const [column, rawIn] of Object.entries(row.cells)) {
    const raw = rawIn ?? '';
    const { entry, viaAlias, ambiguous } = findEntry(ctx.mapping, row.sheet, column);
    const base: NormalizedValue = { column, sourceKey: `${row.sheet}:${column}`, varId: entry?.varId ?? null, concept: null, raw, normalized: null, comparability: 'ungeklaert', outcome: 'ungeklaert' };
    const pushValue = (v: Partial<NormalizedValue>) => values.push({ ...base, ...v });

    if (ambiguous.length) {
      issues.push({ code: 'MAPPING_MEHRDEUTIG', message: `Spalte „${column}“ ist mehrfach zugeordnet`, column, blocking: false });
      pushValue({});
      allArchive = false;
      continue;
    }
    if (!entry) {
      issues.push({ code: 'SPALTE_UNGEMAPPT', message: `Spalte „${column}“ hat keinen Mappingeintrag; Rohwert gesichert`, column, blocking: false });
      pushValue({});
      allArchive = false;
      continue;
    }
    if (viaAlias) issues.push({ code: 'ALIAS_ABWEICHUNG', message: `Spalte „${column}“ entspricht dem SAS-Alias von „${entry.column}“; beide Namen gespeichert`, column, blocking: false });
    if (entry.target.kind !== 'archive') allArchive = false;

    const t = entry.target;
    switch (t.kind) {
      case 'record_id':
        out.recordId = raw || null;
        issues.push({ code: 'PID_IST_BELEG_ID', message: 'P_ID wird als CRF-/Receipt-ID geführt, nicht als Patientenkennung', column, blocking: false });
        pushValue({ normalized: raw, comparability: 'direkt', outcome: 'normalisiert', concept: 'LEGACY_RECORD_ID' });
        break;
      case 'center': {
        out.centerCode = raw || null;
        if (raw === '999') {
          issues.push({ code: 'ZENTRUM_999', message: 'Zentrumscode 999 ist ein vorbelegter Code und kein bestätigtes Zentrum', column, blocking: true });
          pushValue({ concept: 'CENTER' });
        } else if (!ctx.centerMap[raw]) {
          issues.push({ code: 'ZENTRUM_UNBEKANNT', message: `Zentrumscode „${raw}“ ohne bestätigte Zuordnung`, column, blocking: true });
          pushValue({ concept: 'CENTER' });
        } else {
          out.centerId = ctx.centerMap[raw];
          pushValue({ concept: 'CENTER', normalized: ctx.centerMap[raw], comparability: 'transformiert', outcome: 'normalisiert' });
        }
        break;
      }
      case 'visit': {
        const v = ctx.mapping.visitCodes[raw];
        if (!v) {
          issues.push({ code: 'VISITCODE_UNBEKANNT', message: `Visitcode „${raw}“ nicht in der Codeliste`, column, blocking: true });
          pushValue({ concept: 'TIMEPOINT' });
        } else {
          out.timepoint = v.timepoint;
          pushValue({ concept: 'TIMEPOINT', normalized: v.timepoint, comparability: 'transformiert', outcome: 'normalisiert' });
        }
        break;
      }
      case 'op_date': {
        if (!raw) {
          pushValue({ concept: 'OP_DATE' });
          break;
        }
        const d = plausibleDate(raw, maxYear);
        if (!d.iso) {
          issues.push({ code: 'DATUM_UNPLAUSIBEL', message: `OP-Datum „${raw}“: ${d.reason}`, column, blocking: false });
          pushValue({ concept: 'OP_DATE' });
        } else {
          out.opDate = d.iso;
          pushValue({ concept: 'OP_DATE', normalized: d.iso, comparability: 'transformiert', outcome: 'normalisiert' });
        }
        break;
      }
      case 'side': {
        const mapped = entry.codeMap?.[raw];
        if (mapped) {
          out.side = mapped;
          pushValue({ concept: 'SIDE', normalized: mapped, comparability: 'transformiert', outcome: 'normalisiert' });
        } else {
          issues.push({ code: 'CODE_UNBEKANNT', message: `Seite „${raw}“ nicht in Codeliste`, column, blocking: false });
          pushValue({ concept: 'SIDE' });
        }
        break;
      }
      case 'ops': {
        if (!raw) {
          pushValue({ concept: 'PROCEDURE' });
          break;
        }
        const conceptRaw = t.conceptColumn ? row.cells[t.conceptColumn] : undefined;
        const concept = conceptRaw && entry.codeMap ? entry.codeMap[conceptRaw] ?? null : null;
        if (!concept) issues.push({ code: 'OPS_KONZEPT_MEHRDEUTIG', message: `OPS-Code „${raw}“ ohne belegtes Eingriffskonzept; gleiche Codes können verschiedene Konzepte bezeichnen`, column, blocking: false });
        out.procedures.push({ code: raw, concept });
        pushValue({ concept: concept ?? null, normalized: concept ? raw : null, comparability: concept ? 'direkt' : 'ungeklaert', outcome: concept ? 'normalisiert' : 'ungeklaert' });
        break;
      }
      case 'archive':
        pushValue({ outcome: 'archiviert', comparability: 'nicht_vergleichbar' });
        break;
      case 'offen': {
        if (!entry.varId) issues.push({ code: 'VARID_FEHLT', message: `Spalte „${column}“ ohne VARID; zusammengesetzter Quellschlüssel ${base.sourceKey}`, column, blocking: false });
        else if ((varIdCount.get(entry.varId) ?? 0) > 1) issues.push({ code: 'VARID_MEHRFACH', message: `VARID „${entry.varId}“ kommt im Blatt ${row.sheet} mehrfach vor`, column, blocking: false });
        if (t.checkbox && raw === '') issues.push({ code: 'CHECKBOX_LEER', message: `Leere Checkbox „${column}“ wird nicht als Nein/0 interpretiert`, column, blocking: false });
        openColumns++;
        pushValue({ concept: entry.varId ? `${row.sheet}:${entry.varId}` : null });
        break;
      }
      case 'variable': {
        if (!entry.varId) {
          issues.push({ code: 'VARID_FEHLT', message: `Spalte „${column}“ ohne VARID; zusammengesetzter Quellschlüssel ${base.sourceKey}`, column, blocking: false });
          pushValue({ concept: t.concept });
          break;
        }
        if ((varIdCount.get(entry.varId) ?? 0) > 1) {
          issues.push({ code: 'VARID_MEHRFACH', message: `VARID „${entry.varId}“ kommt im Blatt ${row.sheet} mehrfach vor; keine Zuordnung ohne Kontext und Freigabe`, column, blocking: false });
          pushValue({ concept: t.concept });
          break;
        }
        if (entry.classification === 'C') {
          pushValue({ concept: t.concept, normalized: raw === '' ? null : raw, outcome: 'archiviert', comparability: 'nicht_vergleichbar' });
          break;
        }
        if (raw === '') {
          if (t.type === 'checkbox') issues.push({ code: 'CHECKBOX_LEER', message: `Leere Checkbox „${column}“ wird nicht als Nein/0 interpretiert`, column, blocking: false });
          pushValue({ concept: t.concept });
          break;
        }
        if (t.type === 'number') {
          const n = Number(raw.replace(',', '.'));
          if (Number.isFinite(n)) pushValue({ concept: t.concept, normalized: n, comparability: raw.includes(',') ? 'transformiert' : 'direkt', outcome: 'normalisiert' });
          else {
            issues.push({ code: 'ZAHL_UNGUELTIG', message: `„${raw}“ ist keine Zahl`, column, blocking: false });
            pushValue({ concept: t.concept });
          }
        } else if (t.type === 'date') {
          const d = plausibleDate(raw, maxYear);
          if (d.iso) pushValue({ concept: t.concept, normalized: d.iso, comparability: 'transformiert', outcome: 'normalisiert' });
          else {
            issues.push({ code: 'DATUM_UNPLAUSIBEL', message: `Datum „${raw}“ in „${column}“: ${d.reason}`, column, blocking: false });
            pushValue({ concept: t.concept });
          }
        } else if (t.type === 'code' || t.type === 'checkbox') {
          if (entry.codeMap) {
            const mapped = entry.codeMap[raw];
            if (mapped !== undefined) pushValue({ concept: t.concept, normalized: mapped, comparability: 'transformiert', outcome: 'normalisiert' });
            else {
              issues.push({ code: 'CODE_UNBEKANNT', message: `Code „${raw}“ in „${column}“ nicht in der Codeliste`, column, blocking: false });
              pushValue({ concept: t.concept });
            }
          } else pushValue({ concept: t.concept, normalized: raw, comparability: 'direkt', outcome: 'normalisiert' });
        } else {
          pushValue({ concept: t.concept, normalized: raw, comparability: 'direkt', outcome: 'normalisiert' });
        }
        break;
      }
    }
  }

  if (openColumns > 0) {
    issues.push({
      code: 'MAPPING_NICHT_FREIGEGEBEN',
      message: `${openColumns} Spalte(n) ohne freigegebenes Zielkonzept (Mappingversion ${ctx.mapping.code} V${ctx.mapping.version}, Status ${ctx.mapping.status ?? 'vorschlag'}); Rohwerte gesichert`,
      blocking: ctx.mapping.status !== 'freigegeben',
    });
  }
  if (issues.some((i) => i.blocking)) out.outcome = 'ungeklaert';
  else if (allArchive && values.length > 0) out.outcome = 'archiviert';
  return out;
}

/** Bilanz: geliefert = normalisiert + archiviert + ungeklärt + Quarantäne; jede Zeile genau einmal. */
export function reconcile(outcomes: RowOutcome[]): { geliefert: number; normalisiert: number; archiviert: number; ungeklaert: number; quarantaene: number; ausgeglichen: boolean } {
  const c = { normalisiert: 0, archiviert: 0, ungeklaert: 0, quarantaene: 0 };
  for (const o of outcomes) c[o]++;
  const geliefert = outcomes.length;
  return { geliefert, ...c, ausgeglichen: geliefert === c.normalisiert + c.archiviert + c.ungeklaert + c.quarantaene };
}

/** Sortierung nach Codeliste, nicht numerisch nach Visitcode. */
export function sortByTimepoint<T extends { visitCode: string }>(rows: T[], mapping: MappingRuleVersion): T[] {
  return [...rows].sort((a, b) => (mapping.visitCodes[a.visitCode]?.order ?? 9999) - (mapping.visitCodes[b.visitCode]?.order ?? 9999));
}

/**
 * Synthetische Mappingversion für den Prototyp (Quellsystem „DART-ALT-SYNTH“).
 * Bildet die im Lastenheft beschriebenen Fallstricke nach, ohne reale Codierungen zu behaupten.
 */
export const SYNTHETIC_MAPPING_V1: MappingRuleVersion = {
  code: 'MAP-DART-ALT-SYNTH',
  version: 1,
  sourceSystem: 'DART-ALT-SYNTH',
  exportVersions: ['SYNTH-1'],
  visitCodes: {
    '1': { timepoint: 'BL', order: 0 },
    '2': { timepoint: 'M6', order: 1 },
    '3': { timepoint: 'M12', order: 2 },
    '8': { timepoint: 'FU3', order: 3 },
    '4': { timepoint: 'M24', order: 4 },
  },
  entries: [
    { sheet: 'CA', column: 'P_ID', varId: 'CA_001', classification: 'A', target: { kind: 'record_id' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'ZENTRUM', varId: 'CA_002', classification: 'A', target: { kind: 'center' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'VISITCODE', varId: 'CA_003', classification: 'A', target: { kind: 'visit' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'BASELINE_DATE', varId: 'CA_004', classification: 'A', target: { kind: 'op_date' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'SEITE', varId: 'CA_005', classification: 'A', target: { kind: 'side' }, codeMap: { '1': 'links', '2': 'rechts' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'OPS1', varId: 'CA_006', classification: 'B', target: { kind: 'ops', conceptColumn: 'OPS1_ART' }, codeMap: { G: 'KNORPEL_GLAETTUNG', T: 'MENISKUS_TEILRESEKTION' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'OPS1_ART', varId: 'CA_007', classification: 'B', target: { kind: 'variable', concept: 'OPS_ART_ALT', type: 'code' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'SCHMERZ_VAS', varId: 'CA_010', sasAlias: 'CA_VAS', classification: 'B', target: { kind: 'variable', concept: 'SCHMERZ_NRS_BEISPIEL', type: 'number' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'RAUCHER_CB', varId: 'CA_011', classification: 'B', target: { kind: 'variable', concept: 'RAUCHSTATUS_BEISPIEL', type: 'checkbox' }, codeMap: { '1': 'ja', '0': 'nein' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'VOROP_A', varId: 'CA_012', classification: 'B', target: { kind: 'variable', concept: 'VOROP_A', type: 'code' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'VOROP_B', varId: 'CA_012', classification: 'B', target: { kind: 'variable', concept: 'VOROP_B', type: 'code' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'FREITEXT_ALT', varId: null, classification: 'B', target: { kind: 'variable', concept: 'FREITEXT_ALT', type: 'text' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'ALT_SCORE_ORIG', varId: 'CA_020', classification: 'C', target: { kind: 'variable', concept: 'ORIGINALSCORE_ALT', type: 'number' }, status: 'vorschlag' },
    { sheet: 'CA', column: 'FU_ERNEUTOP_YN', varId: 'CA_021', classification: 'B', target: { kind: 'variable', concept: 'ERNEUTE_OP', type: 'code' }, codeMap: { '1': 'ja', '0': 'nein', '9': 'unbekannt' }, status: 'vorschlag' },
    { sheet: 'ARCHIV', column: 'ALTFELD', varId: 'AR_001', classification: 'C', target: { kind: 'archive' }, status: 'vorschlag' },
    { sheet: 'ARCHIV', column: 'P_ID', varId: 'AR_002', classification: 'C', target: { kind: 'archive' }, status: 'vorschlag' },
  ],
};
