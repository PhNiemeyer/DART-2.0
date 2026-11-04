/**
 * Verzweigungsassistent (R-10): einfache Bedingungen ↔ Regel-DSL.
 * Der Assistent erzeugt ausschließlich Whitelist-Operatoren; komplexere Regeln bleiben als JSON erhalten.
 */
import { YESNO_CODES } from './types';
import type { FormItem, FormSchema, Rule } from './types';

export type ConditionOp =
  | 'gleich'
  | 'ungleich'
  | 'einer_von'
  | 'beantwortet'
  | 'nicht_beantwortet'
  | 'groesser'
  | 'groesser_gleich'
  | 'kleiner'
  | 'kleiner_gleich';

export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  gleich: 'ist gleich',
  ungleich: 'ist nicht gleich',
  einer_von: 'ist einer von',
  beantwortet: 'ist beantwortet',
  nicht_beantwortet: 'ist nicht beantwortet',
  groesser: 'ist größer als',
  groesser_gleich: 'ist mindestens',
  kleiner: 'ist kleiner als',
  kleiner_gleich: 'ist höchstens',
};

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: string | number | string[];
}

export interface RuleDraft {
  /** all = alle Bedingungen müssen gelten, any = mindestens eine */
  mode: 'all' | 'any';
  conditions: Condition[];
}

export interface RuleField {
  id: string;
  label: string;
  type: FormItem['type'];
  codes: Array<{ code: string; label: string }>;
}

/** Zulässige Operatoren je Feldtyp. */
export function opsForType(type: FormItem['type']): ConditionOp[] {
  switch (type) {
    case 'number':
    case 'computed':
      return ['gleich', 'ungleich', 'groesser', 'groesser_gleich', 'kleiner', 'kleiner_gleich', 'beantwortet', 'nicht_beantwortet'];
    case 'date':
      return ['groesser', 'groesser_gleich', 'kleiner', 'kleiner_gleich', 'beantwortet', 'nicht_beantwortet'];
    case 'single':
    case 'yesno':
      return ['gleich', 'ungleich', 'einer_von', 'beantwortet', 'nicht_beantwortet'];
    case 'multi':
      return ['einer_von', 'beantwortet', 'nicht_beantwortet'];
    default:
      return ['beantwortet', 'nicht_beantwortet'];
  }
}

const codesOfItem = (it: FormItem) => (it.type === 'yesno' ? YESNO_CODES.map((c) => ({ ...c })) : (it.codes ?? []).map((c) => ({ code: c.code, label: c.label })));

/**
 * Felder, auf die sich eine Bedingung für `itemId` beziehen darf: alle Felder außerhalb von Gruppen
 * und – innerhalb einer Gruppe – die Geschwisterfelder derselben Instanz. Nie das Feld selbst, keine Gruppen.
 */
export function ruleFieldsFor(schema: FormSchema, itemId?: string): RuleField[] {
  const out: RuleField[] = [];
  let ownGroup: FormItem | undefined;
  for (const s of schema.sections) for (const it of s.items) if (it.type === 'group' && (it.items ?? []).some((c) => c.id === itemId)) ownGroup = it;
  for (const s of schema.sections) {
    for (const it of s.items) {
      if (it.type === 'group') {
        if (it === ownGroup) for (const c of it.items ?? []) if (c.id !== itemId && c.type !== 'group') out.push({ id: c.id, label: `${it.label} › ${c.label}`, type: c.type, codes: codesOfItem(c) });
        continue;
      }
      if (it.id === itemId) continue;
      out.push({ id: it.id, label: it.label, type: it.type, codes: codesOfItem(it) });
    }
  }
  return out;
}

function conditionToRule(c: Condition): Rule | null {
  const v = { var: c.field };
  switch (c.op) {
    case 'beantwortet':
      return { exists: c.field };
    case 'nicht_beantwortet':
      return { not: { exists: c.field } };
    case 'gleich':
      return c.value === undefined || Array.isArray(c.value) ? null : { eq: [v, c.value] };
    case 'ungleich':
      return c.value === undefined || Array.isArray(c.value) ? null : { not: { eq: [v, c.value] } };
    case 'einer_von': {
      const list = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [String(c.value)];
      return list.length ? { in: [v, list] } : null;
    }
    case 'groesser':
      return c.value === undefined || Array.isArray(c.value) ? null : { gt: [v, c.value] };
    case 'groesser_gleich':
      return c.value === undefined || Array.isArray(c.value) ? null : { gte: [v, c.value] };
    case 'kleiner':
      return c.value === undefined || Array.isArray(c.value) ? null : { lt: [v, c.value] };
    case 'kleiner_gleich':
      return c.value === undefined || Array.isArray(c.value) ? null : { lte: [v, c.value] };
  }
}

/** Entwurf → Regel. Unvollständige Bedingungen werden übersprungen; ohne Bedingung: keine Regel (immer sichtbar). */
export function ruleFromDraft(d: RuleDraft): Rule | undefined {
  const rules = d.conditions.map(conditionToRule).filter((r): r is Rule => r !== null);
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  return d.mode === 'any' ? { any: rules } : { all: rules };
}

const isVar = (o: unknown): o is { var: string } => typeof o === 'object' && o !== null && !Array.isArray(o) && typeof (o as { var?: unknown }).var === 'string';
const isLit = (o: unknown): o is string | number => typeof o === 'string' || typeof o === 'number';

function ruleToCondition(r: Rule): Condition | null {
  const k = Object.keys(r)[0];
  const x = (r as Record<string, unknown>)[k];
  if (k === 'exists' && typeof x === 'string') return { field: x, op: 'beantwortet' };
  if (k === 'not') {
    const inner = x as Rule;
    const ik = Object.keys(inner ?? {})[0];
    const ix = (inner as Record<string, unknown>)?.[ik];
    if (ik === 'exists' && typeof ix === 'string') return { field: ix, op: 'nicht_beantwortet' };
    if (ik === 'eq' && Array.isArray(ix) && isVar(ix[0]) && isLit(ix[1])) return { field: ix[0].var, op: 'ungleich', value: ix[1] };
    return null;
  }
  const map: Record<string, ConditionOp> = { eq: 'gleich', gt: 'groesser', gte: 'groesser_gleich', lt: 'kleiner', lte: 'kleiner_gleich' };
  if (map[k] && Array.isArray(x) && isVar(x[0]) && isLit(x[1])) return { field: x[0].var, op: map[k], value: x[1] };
  if (k === 'in' && Array.isArray(x) && isVar(x[0]) && Array.isArray(x[1]) && x[1].every((e) => typeof e === 'string')) return { field: x[0].var, op: 'einer_von', value: x[1] as string[] };
  return null;
}

/** Regel → Entwurf, falls die Regel im Assistenten darstellbar ist; sonst null (dann nur JSON-Bearbeitung). */
export function draftFromRule(rule: Rule | undefined): RuleDraft | null {
  if (!rule) return { mode: 'all', conditions: [] };
  const k = Object.keys(rule)[0];
  if (k === 'all' || k === 'any') {
    const list = (rule as { all?: Rule[]; any?: Rule[] })[k as 'all' | 'any'] ?? [];
    const conditions = list.map(ruleToCondition);
    return conditions.every((c): c is Condition => c !== null) ? { mode: k, conditions } : null;
  }
  const c = ruleToCondition(rule);
  return c ? { mode: 'all', conditions: [c] } : null;
}

/** Deutsche Klartextbeschreibung einer Regel (für Editor, Prüfung und Versionsvergleich). */
export function describeRule(rule: Rule | undefined, schema?: FormSchema): string {
  if (!rule) return 'immer sichtbar';
  const fields = new Map<string, FormItem>();
  for (const s of schema?.sections ?? []) for (const it of s.items) {
    fields.set(it.id, it);
    for (const c of it.items ?? []) fields.set(c.id, c);
  }
  const name = (id: string) => (fields.get(id) ? `„${fields.get(id)!.label}“` : `„${id}“`);
  const val = (id: string, v: unknown) => {
    const it = fields.get(id);
    const code = it ? codesOfItem(it).find((c) => c.code === v) : undefined;
    return code ? `„${code.label}“` : typeof v === 'string' ? `„${v}“` : String(v);
  };
  const d = draftFromRule(rule);
  if (!d) return `komplexe Regel: ${JSON.stringify(rule)}`;
  const parts = d.conditions.map((c) => {
    const op = CONDITION_OP_LABELS[c.op];
    if (c.op === 'beantwortet' || c.op === 'nicht_beantwortet') return `${name(c.field)} ${op}`;
    if (Array.isArray(c.value)) return `${name(c.field)} ${op} ${c.value.map((x) => val(c.field, x)).join(', ')}`;
    return `${name(c.field)} ${op} ${val(c.field, c.value)}`;
  });
  return `sichtbar, wenn ${parts.join(d.mode === 'any' ? ' oder ' : ' und ')}`;
}
