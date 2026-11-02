import { Operand, Rule, RULE_OPERATORS } from './types';

export type Resolver = (varName: string) => unknown;

function isVarRef(o: unknown): o is { var: string } {
  return typeof o === 'object' && o !== null && !Array.isArray(o) && typeof (o as { var?: unknown }).var === 'string';
}

function resolve(o: Operand, r: Resolver): unknown {
  return isVarRef(o) ? r(o.var) : o;
}

function present(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function cmp(a: unknown, b: unknown): number | undefined {
  const na = num(a);
  const nb = num(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  // ISO-Datum (YYYY-MM-DD) ist lexikografisch vergleichbar
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return undefined;
}

/**
 * Wertet eine Regel deterministisch aus. Identische Funktion auf Client und Server.
 * Fehlende/inaktive Werte: eq/in/Vergleiche → false, exists → false.
 */
export function evaluateRule(rule: Rule, r: Resolver): boolean {
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new Error('Regel muss genau einen Operator enthalten');
  const op = keys[0];
  const arg = (rule as Record<string, unknown>)[op];
  switch (op) {
    case 'all':
      return (arg as Rule[]).every((x) => evaluateRule(x, r));
    case 'any':
      return (arg as Rule[]).some((x) => evaluateRule(x, r));
    case 'not':
      return !evaluateRule(arg as Rule, r);
    case 'exists':
      return present(r(arg as string));
    case 'eq': {
      const [a, b] = arg as [Operand, Operand];
      const va = resolve(a, r);
      const vb = resolve(b, r);
      if (!present(va) || !present(vb)) return false;
      if (Array.isArray(va)) return va.includes(vb as string);
      return va === vb;
    }
    case 'in': {
      const [a, list] = arg as [Operand, unknown[]];
      const va = resolve(a, r);
      if (!present(va)) return false;
      if (Array.isArray(va)) return va.some((x) => list.includes(x));
      return list.includes(va);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = arg as [Operand, Operand];
      const c = cmp(resolve(a, r), resolve(b, r));
      if (c === undefined) return false;
      if (op === 'gt') return c > 0;
      if (op === 'gte') return c >= 0;
      if (op === 'lt') return c < 0;
      return c <= 0;
    }
    default:
      throw new Error(`Unzulässiger Regeloperator: ${op}`);
  }
}

export interface RuleRef {
  varName: string;
  /** Operator, in dem die Referenz vorkommt (für Typprüfung). */
  op: string;
  /** Literal, mit dem verglichen wird (falls vorhanden). */
  literals: unknown[];
}

/** Strukturelle Prüfung + Sammeln aller Variablenreferenzen. */
export function inspectRule(rule: unknown, path = 'regel'): { refs: RuleRef[]; errors: string[] } {
  const refs: RuleRef[] = [];
  const errors: string[] = [];
  const walk = (node: unknown, p: string) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      errors.push(`${p}: Regel muss ein Objekt sein`);
      return;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      errors.push(`${p}: Regel muss genau einen Operator enthalten`);
      return;
    }
    const op = keys[0];
    const arg = (node as Record<string, unknown>)[op];
    if (!(RULE_OPERATORS as readonly string[]).includes(op)) {
      errors.push(`${p}: unzulässiger Operator „${op}“ (erlaubt: ${RULE_OPERATORS.join(', ')})`);
      return;
    }
    if (op === 'all' || op === 'any') {
      if (!Array.isArray(arg) || arg.length === 0) errors.push(`${p}.${op}: erwartet nicht-leere Liste`);
      else arg.forEach((x, i) => walk(x, `${p}.${op}[${i}]`));
      return;
    }
    if (op === 'not') {
      walk(arg, `${p}.not`);
      return;
    }
    if (op === 'exists') {
      if (typeof arg !== 'string' || !arg) errors.push(`${p}.exists: erwartet Variablenname`);
      else refs.push({ varName: arg, op, literals: [] });
      return;
    }
    if (!Array.isArray(arg) || arg.length !== 2) {
      errors.push(`${p}.${op}: erwartet genau zwei Operanden`);
      return;
    }
    if (op === 'in') {
      const [a, list] = arg;
      if (!Array.isArray(list)) errors.push(`${p}.in: zweiter Operand muss eine Liste sein`);
      checkOperand(a, `${p}.in[0]`, Array.isArray(list) ? list : []);
      return;
    }
    const [a, b] = arg;
    const litA = isVarRef(a) ? [] : [a];
    const litB = isVarRef(b) ? [] : [b];
    checkOperand(a, `${p}.${op}[0]`, litB, op);
    checkOperand(b, `${p}.${op}[1]`, litA, op);
  };
  const checkOperand = (o: unknown, p: string, literals: unknown[], op = 'in') => {
    if (isVarRef(o)) {
      refs.push({ varName: o.var, op, literals });
      return;
    }
    if (o === null || ['string', 'number', 'boolean'].includes(typeof o)) return;
    errors.push(`${p}: ungültiger Operand`);
  };
  walk(rule, path);
  return { refs, errors };
}
