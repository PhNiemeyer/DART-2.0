/**
 * Versionsvergleich zweier Formularschemata (R-10). Vergleich über stabile Item-IDs.
 * „kritisch“ markiert Änderungen, die Auswertungen über Versionen hinweg betreffen
 * (Datentyp, Variablenkennung, entfernte Codes oder Felder, enger gewordene Grenzen, neue Pflicht).
 */
import { describeRule } from './builder';
import { canonicalJson } from './engine';
import { ITEM_TYPE_LABELS, MISSING_CODES } from './types';
import type { FormItem, FormSchema, MissingCode } from './types';

export type DiffSeverity = 'kritisch' | 'hinweis';

export interface FieldChange {
  feld: string;
  vorher: string;
  nachher: string;
  schwere: DiffSeverity;
  grund?: string;
}

export interface ItemDiff {
  art: 'neu' | 'entfernt' | 'geaendert' | 'verschoben';
  itemId: string;
  label: string;
  /** Abschnitt bzw. Gruppe im Zielschema (bei „entfernt“ im Ausgangsschema) */
  ort: string;
  schwere: DiffSeverity;
  aenderungen: FieldChange[];
}

export interface SectionDiff {
  art: 'neu' | 'entfernt' | 'umbenannt' | 'regel';
  sectionId: string;
  vorher?: string;
  nachher?: string;
}

export interface SchemaDiff {
  abschnitte: SectionDiff[];
  felder: ItemDiff[];
  anzahl: { neu: number; entfernt: number; geaendert: number; verschoben: number; kritisch: number };
  /** true, wenn sich nichts geändert hat (kanonischer Vergleich) */
  identisch: boolean;
}

interface Located {
  item: FormItem;
  ort: string;
  /** Position für Verschiebungserkennung: Abschnitt/Gruppe und Index */
  pos: string;
}

function locate(schema: FormSchema): Map<string, Located> {
  const m = new Map<string, Located>();
  for (const s of schema.sections) {
    s.items.forEach((it, i) => {
      m.set(it.id, { item: it, ort: s.title, pos: `${s.id}#${i}` });
      (it.items ?? []).forEach((c, j) => m.set(c.id, { item: c, ort: `${s.title} › ${it.label}`, pos: `${it.id}#${j}` }));
    });
  }
  return m;
}

const fmtCodes = (it: FormItem) => (it.codes ?? []).map((c) => `${c.code}=${c.label}`).join('; ') || '–';
const fmtNum = (n: number | undefined) => (n === undefined ? '–' : String(n));
const fmtMissing = (l?: MissingCode[]) => (l?.length ? l.map((m) => MISSING_CODES[m] ?? m).join(', ') : '–');

function compareItem(a: FormItem, b: FormItem, sa: FormSchema, sb: FormSchema): FieldChange[] {
  const ch: FieldChange[] = [];
  const add = (feld: string, vorher: string, nachher: string, schwere: DiffSeverity, grund?: string) => {
    if (vorher !== nachher) ch.push({ feld, vorher, nachher, schwere, grund });
  };
  add('Label', a.label, b.label, 'hinweis');
  add('Hilfetext', a.help ?? '–', b.help ?? '–', 'hinweis');
  add('Datentyp', ITEM_TYPE_LABELS[a.type] ?? a.type, ITEM_TYPE_LABELS[b.type] ?? b.type, 'kritisch', 'Werte sind über die Versionen nicht direkt vergleichbar');
  add('Variablenkennung', a.varId, b.varId, 'kritisch', 'Zeitreihe der Variable wird unterbrochen');
  add('Einheit', a.unit ?? '–', b.unit ?? '–', 'kritisch', 'Messwerte erfordern Umrechnung');
  // Codes
  const ca = new Map((a.codes ?? []).map((c) => [c.code, c.label]));
  const cb = new Map((b.codes ?? []).map((c) => [c.code, c.label]));
  const removed = [...ca.keys()].filter((k) => !cb.has(k));
  const added = [...cb.keys()].filter((k) => !ca.has(k));
  const relabeled = [...ca.keys()].filter((k) => cb.has(k) && ca.get(k) !== cb.get(k));
  if (removed.length || added.length || relabeled.length) {
    ch.push({
      feld: 'Codes',
      vorher: fmtCodes(a),
      nachher: fmtCodes(b),
      schwere: removed.length ? 'kritisch' : 'hinweis',
      grund: [removed.length ? `entfernt: ${removed.join(', ')}` : '', added.length ? `neu: ${added.join(', ')}` : '', relabeled.length ? `umbenannt: ${relabeled.join(', ')}` : ''].filter(Boolean).join(' · '),
    });
  }
  if (!!a.required !== !!b.required) add('Pflichtfeld', a.required ? 'ja' : 'nein', b.required ? 'ja' : 'nein', b.required ? 'kritisch' : 'hinweis', b.required ? 'Laufende Erhebungen können zusätzliche Angaben benötigen' : undefined);
  const narrowed = (b.min !== undefined && (a.min === undefined || b.min > a.min)) || (b.max !== undefined && (a.max === undefined || b.max < a.max));
  if (a.min !== b.min || a.max !== b.max) ch.push({ feld: 'Wertebereich', vorher: `${fmtNum(a.min)} bis ${fmtNum(a.max)}`, nachher: `${fmtNum(b.min)} bis ${fmtNum(b.max)}`, schwere: narrowed ? 'kritisch' : 'hinweis', grund: narrowed ? 'Bisher gültige Werte können außerhalb liegen' : undefined });
  add('Nachkommastellen', fmtNum(a.decimals), fmtNum(b.decimals), 'hinweis');
  add('Verzweigung', describeRule(a.visibleIf, sa), describeRule(b.visibleIf, sb), 'hinweis');
  add('Zulässige Fehlgründe', fmtMissing(a.allowedMissing), fmtMissing(b.allowedMissing), 'hinweis');
  add('Prüfregeln', canonicalJson(a.validations ?? []), canonicalJson(b.validations ?? []), 'hinweis');
  if (a.type === 'group' || b.type === 'group') {
    const r = (x: FormItem) => (x.repeat ? `${x.repeat.min}–${x.repeat.max} × „${x.repeat.instanceLabel}“` : '–');
    add('Wiederholung', r(a), r(b), b.repeat && a.repeat && b.repeat.max < a.repeat.max ? 'kritisch' : 'hinweis');
  }
  if (a.compute || b.compute) add('Berechnung', canonicalJson(a.compute ?? null), canonicalJson(b.compute ?? null), 'kritisch', 'Scorewerte sind neu zu berechnen und getrennt zu versionieren');
  return ch;
}

export function diffSchemas(a: FormSchema, b: FormSchema): SchemaDiff {
  const abschnitte: SectionDiff[] = [];
  const sa = new Map(a.sections.map((s) => [s.id, s]));
  const sb = new Map(b.sections.map((s) => [s.id, s]));
  for (const s of b.sections) {
    const o = sa.get(s.id);
    if (!o) abschnitte.push({ art: 'neu', sectionId: s.id, nachher: s.title });
    else {
      if (o.title !== s.title) abschnitte.push({ art: 'umbenannt', sectionId: s.id, vorher: o.title, nachher: s.title });
      if (canonicalJson(o.visibleIf ?? null) !== canonicalJson(s.visibleIf ?? null)) abschnitte.push({ art: 'regel', sectionId: s.id, vorher: describeRule(o.visibleIf, a), nachher: describeRule(s.visibleIf, b) });
    }
  }
  for (const s of a.sections) if (!sb.has(s.id)) abschnitte.push({ art: 'entfernt', sectionId: s.id, vorher: s.title });

  const la = locate(a);
  const lb = locate(b);
  const felder: ItemDiff[] = [];
  for (const [id, nb] of lb) {
    const na = la.get(id);
    if (!na) {
      felder.push({ art: 'neu', itemId: id, label: nb.item.label, ort: nb.ort, schwere: 'hinweis', aenderungen: [] });
      continue;
    }
    const ch = compareItem(na.item, nb.item, a, b);
    if (ch.length) felder.push({ art: 'geaendert', itemId: id, label: nb.item.label, ort: nb.ort, schwere: ch.some((c) => c.schwere === 'kritisch') ? 'kritisch' : 'hinweis', aenderungen: ch });
    else if (na.pos !== nb.pos) felder.push({ art: 'verschoben', itemId: id, label: nb.item.label, ort: nb.ort, schwere: 'hinweis', aenderungen: [{ feld: 'Position', vorher: na.ort, nachher: nb.ort, schwere: 'hinweis' }] });
  }
  for (const [id, na] of la) {
    if (!lb.has(id)) felder.push({ art: 'entfernt', itemId: id, label: na.item.label, ort: na.ort, schwere: 'kritisch', aenderungen: [{ feld: 'Feld', vorher: na.item.label, nachher: '–', schwere: 'kritisch', grund: 'Wird nicht mehr erhoben; bisherige Werte bleiben gespeichert' }] });
  }
  const count = (art: ItemDiff['art']) => felder.filter((f) => f.art === art).length;
  return {
    abschnitte,
    felder,
    anzahl: { neu: count('neu'), entfernt: count('entfernt'), geaendert: count('geaendert'), verschoben: count('verschoben'), kritisch: felder.filter((f) => f.schwere === 'kritisch').length },
    identisch: canonicalJson(a.sections) === canonicalJson(b.sections),
  };
}
