import { evaluateRule, inspectRule } from './rules';
import { getScoreAlgorithm } from './scores';
import {
  answerKey,
  AnswerValue,
  FormItem,
  FormSchema,
  FormSection,
  ITEM_TYPES,
  MISSING_CODES,
  MissingCode,
  ResponseData,
  Rule,
  YESNO_CODES,
} from './types';

export interface SchemaError {
  path: string;
  message: string;
}

interface ItemIndexEntry {
  item: FormItem;
  section: FormSection;
  group?: FormItem;
}

export function indexItems(schema: FormSchema): Map<string, ItemIndexEntry> {
  const idx = new Map<string, ItemIndexEntry>();
  for (const section of schema.sections) {
    for (const item of section.items) {
      idx.set(item.id, { item, section });
      if (item.type === 'group') for (const child of item.items ?? []) idx.set(child.id, { item: child, section, group: item });
    }
  }
  return idx;
}

export function codesOf(item: FormItem): string[] {
  if (item.type === 'yesno') return YESNO_CODES.map((c) => c.code);
  return (item.codes ?? []).map((c) => c.code);
}

/**
 * Prüft ein Schema vor der Veröffentlichung: eindeutige Kennungen, Typen,
 * gültige Regelreferenzen, Typverträglichkeit und Zyklenfreiheit (F09).
 */
export function validateSchema(schema: FormSchema): SchemaError[] {
  const errors: SchemaError[] = [];
  if (!schema || typeof schema !== 'object') return [{ path: '', message: 'Schema fehlt' }];
  if (schema.schemaVersion !== 1) errors.push({ path: 'schemaVersion', message: 'Nur schemaVersion 1 wird unterstützt' });
  if (!schema.code || !/^[A-Z0-9_-]{2,40}$/.test(schema.code)) errors.push({ path: 'code', message: 'Formularcode fehlt oder ist ungültig (A–Z, 0–9, _ und -)' });
  if (!schema.title) errors.push({ path: 'title', message: 'Titel fehlt' });
  if (!['arzt', 'patient'].includes(schema.audience)) errors.push({ path: 'audience', message: 'Zielgruppe muss „arzt“ oder „patient“ sein' });
  if (!Array.isArray(schema.sections) || schema.sections.length === 0) {
    errors.push({ path: 'sections', message: 'Mindestens ein Abschnitt erforderlich' });
    return errors;
  }

  const ids = new Set<string>();
  const varIds = new Set<string>();
  const sectionIds = new Set<string>();
  const idRe = /^[a-z][a-z0-9_]{0,63}$/;

  const checkItem = (item: FormItem, p: string, inGroup: boolean) => {
    if (!item.id || !idRe.test(item.id)) errors.push({ path: `${p}.id`, message: `Ungültige Item-ID „${item.id ?? ''}“ (klein, a–z, 0–9, _)` });
    else if (ids.has(item.id)) errors.push({ path: `${p}.id`, message: `Doppelte Item-ID „${item.id}“` });
    else ids.add(item.id);
    if (item.type !== 'group') {
      if (!item.varId) errors.push({ path: `${p}.varId`, message: `Variablenkennung fehlt bei „${item.id}“` });
      else if (varIds.has(item.varId)) errors.push({ path: `${p}.varId`, message: `Doppelte Variablenkennung „${item.varId}“` });
      else varIds.add(item.varId);
    }
    if (!item.label) errors.push({ path: `${p}.label`, message: `Deutsches Label fehlt bei „${item.id}“` });
    if (!ITEM_TYPES.includes(item.type)) {
      errors.push({ path: `${p}.type`, message: `Unbekannter Feldtyp „${item.type}“ (neue Feldtypen erfordern einen Programmdeploy)` });
      return;
    }
    if ((item.type === 'single' || item.type === 'multi') && (!item.codes || item.codes.length === 0)) {
      errors.push({ path: `${p}.codes`, message: `Codeliste fehlt bei „${item.id}“` });
    }
    if (item.codes) {
      const seen = new Set<string>();
      for (const c of item.codes) {
        if (!c.code || !c.label) errors.push({ path: `${p}.codes`, message: `Code ohne Kennung oder Label bei „${item.id}“` });
        if (seen.has(c.code)) errors.push({ path: `${p}.codes`, message: `Doppelter Code „${c.code}“ bei „${item.id}“` });
        seen.add(c.code);
      }
    }
    if (item.min !== undefined && item.max !== undefined && item.min > item.max) {
      errors.push({ path: `${p}`, message: `Minimum größer als Maximum bei „${item.id}“` });
    }
    for (const m of item.allowedMissing ?? []) {
      if (!(m in MISSING_CODES)) errors.push({ path: `${p}.allowedMissing`, message: `Unbekannter Fehlgrund „${m}“` });
    }
    if (item.type === 'computed') {
      if (!item.compute) errors.push({ path: `${p}.compute`, message: `Berechnungsvorschrift fehlt bei „${item.id}“` });
      else if (!getScoreAlgorithm(item.compute.algorithm)) errors.push({ path: `${p}.compute`, message: `Unbekannter Scorealgorithmus „${item.compute.algorithm}“` });
    }
    if (item.type === 'group') {
      if (inGroup) errors.push({ path: p, message: 'Verschachtelte Gruppen werden nicht unterstützt' });
      if (!item.items || item.items.length === 0) errors.push({ path: `${p}.items`, message: `Gruppe „${item.id}“ ohne Felder` });
      if (!item.repeat) errors.push({ path: `${p}.repeat`, message: `Wiederholungsangaben fehlen bei Gruppe „${item.id}“` });
      else if (item.repeat.min < 0 || item.repeat.max < 1 || item.repeat.min > item.repeat.max) errors.push({ path: `${p}.repeat`, message: `Ungültige Wiederholungsgrenzen bei „${item.id}“` });
      (item.items ?? []).forEach((c, i) => checkItem(c, `${p}.items[${i}]`, true));
    }
  };

  schema.sections.forEach((s, si) => {
    if (!s.id || !idRe.test(s.id)) errors.push({ path: `sections[${si}].id`, message: `Ungültige Abschnitts-ID „${s.id ?? ''}“` });
    else if (sectionIds.has(s.id)) errors.push({ path: `sections[${si}].id`, message: `Doppelte Abschnitts-ID „${s.id}“` });
    sectionIds.add(s.id);
    if (!s.title) errors.push({ path: `sections[${si}].title`, message: 'Abschnittstitel fehlt' });
    (s.items ?? []).forEach((it, ii) => checkItem(it, `sections[${si}].items[${ii}]`, false));
  });
  if (errors.length) return errors;

  // Regeln prüfen: Referenzen, Typen, Gruppengrenzen; Abhängigkeitsgraph aufbauen.
  const idx = indexItems(schema);
  const deps = new Map<string, Set<string>>();
  const addDeps = (from: string, refs: string[]) => {
    const set = deps.get(from) ?? new Set<string>();
    refs.forEach((r) => set.add(r));
    deps.set(from, set);
  };

  const checkRule = (rule: Rule | undefined, p: string, owner: string, ownerGroup?: FormItem, allowSelf = false): string[] => {
    if (rule === undefined) return [];
    const { refs, errors: ruleErrors } = inspectRule(rule, p);
    ruleErrors.forEach((m) => errors.push({ path: p, message: m }));
    const names: string[] = [];
    for (const ref of refs) {
      const target = idx.get(ref.varName);
      if (!target) {
        errors.push({ path: p, message: `Regel verweist auf unbekanntes Feld „${ref.varName}“` });
        continue;
      }
      if (target.item.type === 'group') {
        errors.push({ path: p, message: `Regel darf nicht direkt auf die Gruppe „${ref.varName}“ verweisen` });
        continue;
      }
      if (target.group && target.group !== ownerGroup) {
        errors.push({ path: p, message: `Verweis von außen in die wiederholbare Gruppe „${target.group.id}“ ist nicht zulässig („${ref.varName}“)` });
        continue;
      }
      if (ref.varName === owner && !allowSelf) {
        errors.push({ path: p, message: `Feld „${owner}“ verweist auf sich selbst` });
        continue;
      }
      const t = target.item.type;
      if (['gt', 'gte', 'lt', 'lte'].includes(ref.op)) {
        if (!['number', 'computed', 'date'].includes(t)) errors.push({ path: p, message: `Vergleich „${ref.op}“ mit nicht-numerischem Feld „${ref.varName}“ (${t})` });
        for (const lit of ref.literals) {
          if (t === 'date' ? typeof lit !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lit) : typeof lit !== 'number') {
            errors.push({ path: p, message: `Typfehler: „${ref.varName}“ (${t}) wird mit ${JSON.stringify(lit)} verglichen` });
          }
        }
      }
      if (ref.op === 'eq' || ref.op === 'in') {
        const codes = codesOf(target.item);
        for (const lit of ref.literals) {
          if (lit === null) continue;
          if (['single', 'multi', 'yesno'].includes(t) && !codes.includes(String(lit))) {
            errors.push({ path: p, message: `Code ${JSON.stringify(lit)} ist für „${ref.varName}“ nicht definiert` });
          } else if ((t === 'number' || t === 'computed') && typeof lit !== 'number') {
            errors.push({ path: p, message: `Typfehler: Zahlenfeld „${ref.varName}“ mit ${JSON.stringify(lit)} verglichen` });
          }
        }
      }
      names.push(ref.varName);
    }
    return names;
  };

  schema.sections.forEach((s, si) => {
    const sectionRefs = checkRule(s.visibleIf, `sections[${si}].visibleIf`, `§${s.id}`);
    const visit = (item: FormItem, p: string, group?: FormItem) => {
      const refs = [...sectionRefs];
      if (group) refs.push(group.id);
      refs.push(...checkRule(item.visibleIf, `${p}.visibleIf`, item.id, group));
      (item.validations ?? []).forEach((v, vi) => {
        if (!v.message) errors.push({ path: `${p}.validations[${vi}]`, message: 'Prüfregel ohne Meldung' });
        checkRule(v.rule, `${p}.validations[${vi}]`, item.id, group, true);
      });
      if (item.compute) {
        for (const input of item.compute.inputs) {
          const target = idx.get(input);
          if (!target) errors.push({ path: `${p}.compute`, message: `Berechnung verweist auf unbekanntes Feld „${input}“` });
          else if (target.group && target.group !== group) errors.push({ path: `${p}.compute`, message: `Berechnung darf nicht auf Gruppenfeld „${input}“ verweisen` });
          else refs.push(input);
        }
      }
      addDeps(item.id, refs);
      if (item.type === 'group') (item.items ?? []).forEach((c, ci) => visit(c, `${p}.items[${ci}]`, item));
    };
    s.items.forEach((it, ii) => visit(it, `sections[${si}].items[${ii}]`));
  });

  // Zyklenprüfung (DFS)
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const dfs = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of deps.get(n) ?? []) {
      if (state.get(m) === 1) {
        const cycle = [...stack.slice(stack.indexOf(m)), m].join(' → ');
        if (!reported.has(cycle)) {
          reported.add(cycle);
          errors.push({ path: 'regeln', message: `Zyklische Abhängigkeit: ${cycle}` });
        }
      } else if (!state.get(m)) dfs(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of deps.keys()) if (!state.get(n)) dfs(n);
  return errors;
}

export interface Issue {
  key: string;
  itemId: string;
  message: string;
  severity: 'fehler' | 'hinweis';
  kind: 'pflicht' | 'typ' | 'bereich' | 'regel' | 'missing' | 'gruppe';
}

export interface ScoreOutcome {
  key: string;
  itemId: string;
  algorithm: string;
  value: number | null;
  reason?: string;
  usedInputs: number;
  totalInputs: number;
}

export interface FormEvaluation {
  /** Antwortschlüssel sichtbarer Eingabefelder (inkl. Gruppeninstanzen). */
  visibleKeys: string[];
  /** Sichtbare wiederholbare Gruppen (Gruppenregel und Abschnitt erfüllt). */
  visibleGroups: string[];
  /** Vorhandene Antworten, die aktuell ausgeblendet sind (bleiben erhalten, inaktiv). */
  inactiveKeys: string[];
  visibleSections: string[];
  scores: ScoreOutcome[];
  issues: Issue[];
  progress: { answered: number; total: number; requiredOpen: number };
}

function hasValue(a: AnswerValue | undefined): boolean {
  if (!a) return false;
  const v = a.value;
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function isAnswered(a: AnswerValue | undefined): boolean {
  return hasValue(a) || !!a?.missing;
}

function decimalsOf(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Vollständige, deterministische Auswertung eines Formulars: Sichtbarkeit,
 * inaktive (ausgeblendete) Antworten, Scores aus aktiven Antworten, Prüfungen.
 */
export function evaluateForm(schema: FormSchema, data: ResponseData): FormEvaluation {
  const idx = indexItems(schema);
  const answers = data.answers ?? {};
  const instances = data.instances ?? {};
  const visCache = new Map<string, boolean>();
  const computing = new Set<string>();
  const scoreCache = new Map<string, ScoreOutcome>();
  const sectionVisCache = new Map<string, boolean>();

  const scopeKey = (itemId: string, group?: FormItem, instanceId?: string) => answerKey(itemId, group?.id, instanceId);

  const makeResolver = (group?: FormItem, instanceId?: string) => (name: string): unknown => {
    const target = idx.get(name);
    if (!target) return undefined;
    const inst = target.group ? instanceId : undefined;
    if (target.group && (target.group !== group || !instanceId)) return undefined;
    if (!isVisible(name, target.group, inst)) return undefined;
    if (target.item.type === 'computed') return computeScore(target.item, target.group, inst).value ?? undefined;
    const a = answers[scopeKey(name, target.group, inst)];
    return hasValue(a) ? a!.value : undefined;
  };

  const isSectionVisible = (section: FormSection): boolean => {
    if (sectionVisCache.has(section.id)) return sectionVisCache.get(section.id)!;
    const v = section.visibleIf ? evaluateRule(section.visibleIf, makeResolver()) : true;
    sectionVisCache.set(section.id, v);
    return v;
  };

  function isVisible(itemId: string, group?: FormItem, instanceId?: string): boolean {
    const key = scopeKey(itemId, group, instanceId);
    if (visCache.has(key)) return visCache.get(key)!;
    if (computing.has(key)) return false; // Schutz; Zyklen werden vor Veröffentlichung abgelehnt
    computing.add(key);
    const entry = idx.get(itemId)!;
    let v = isSectionVisible(entry.section);
    if (v && entry.group) v = isVisible(entry.group.id);
    if (v && entry.item.visibleIf) v = evaluateRule(entry.item.visibleIf, makeResolver(entry.group, instanceId));
    computing.delete(key);
    visCache.set(key, v);
    return v;
  }

  function computeScore(item: FormItem, group?: FormItem, instanceId?: string): ScoreOutcome {
    const key = scopeKey(item.id, group, instanceId);
    if (scoreCache.has(key)) return scoreCache.get(key)!;
    const alg = getScoreAlgorithm(item.compute!.algorithm);
    const resolver = makeResolver(group, instanceId);
    const tf = item.compute!.transforms ?? {};
    const maxima: Array<number | undefined> = [];
    const values = item.compute!.inputs.map((inp) => {
      const raw = resolver(inp);
      let n: number | undefined;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) n = Number(raw);
      const t = tf[inp];
      maxima.push(t ? t.max - t.min : undefined);
      if (n === undefined || !t) return n;
      return t.reverse ? t.max - n : n - t.min;
    });
    const res = alg ? alg.compute(values, maxima) : { value: null, reason: 'Unbekannter Algorithmus', usedInputs: 0, totalInputs: values.length };
    const out: ScoreOutcome = { key, itemId: item.id, algorithm: item.compute!.algorithm, ...res };
    scoreCache.set(key, out);
    return out;
  }

  const visibleKeys: string[] = [];
  const visibleGroups: string[] = [];
  const issues: Issue[] = [];
  const scores: ScoreOutcome[] = [];
  const visibleSections: string[] = [];
  let answered = 0;
  let total = 0;
  let requiredOpen = 0;
  const validKeys = new Set<string>();

  const checkInput = (item: FormItem, group?: FormItem, instanceId?: string) => {
    const key = scopeKey(item.id, group, instanceId);
    validKeys.add(key);
    if (!isVisible(item.id, group, instanceId)) return;
    if (item.type === 'computed') {
      visibleKeys.push(key);
      scores.push(computeScore(item, group, instanceId));
      return;
    }
    visibleKeys.push(key);
    total++;
    const a = answers[key];
    if (isAnswered(a)) answered++;
    const push = (message: string, kind: Issue['kind'], severity: Issue['severity'] = 'fehler') =>
      issues.push({ key, itemId: item.id, message, severity, kind });

    if (hasValue(a) && a!.missing) {
      push('Bitte entweder einen Wert oder einen Fehlgrund angeben, nicht beides.', 'missing');
      return;
    }
    if (a?.missing) {
      if (!(item.allowedMissing ?? []).includes(a.missing as MissingCode)) push(`Fehlgrund „${MISSING_CODES[a.missing as MissingCode] ?? a.missing}“ ist für dieses Feld nicht zulässig.`, 'missing');
      return;
    }
    if (!hasValue(a)) {
      if (item.required) {
        requiredOpen++;
        push('Pflichtangabe fehlt.', 'pflicht');
      }
      return;
    }
    const v = a!.value;
    switch (item.type) {
      case 'text':
        if (typeof v !== 'string') push('Bitte Text eingeben.', 'typ');
        else if (v.length > 4000) push('Text ist zu lang (höchstens 4000 Zeichen).', 'bereich');
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) push('Bitte eine gültige Zahl eingeben.', 'typ');
        else {
          if (item.min !== undefined && v < item.min) push(`Wert liegt unter dem zulässigen Minimum (${item.min.toLocaleString('de-DE')}).`, 'bereich');
          if (item.max !== undefined && v > item.max) push(`Wert liegt über dem zulässigen Maximum (${item.max.toLocaleString('de-DE')}).`, 'bereich');
          if (item.decimals !== undefined && decimalsOf(v) > item.decimals) push(`Höchstens ${item.decimals} Nachkommastelle(n) zulässig.`, 'bereich');
        }
        break;
      case 'date':
        if (typeof v !== 'string' || !isValidIsoDate(v)) push('Bitte ein gültiges Datum eingeben (TT.MM.JJJJ).', 'typ');
        break;
      case 'single':
      case 'yesno':
        if (typeof v !== 'string' || !codesOf(item).includes(v)) push('Bitte eine der vorgegebenen Antworten wählen.', 'typ');
        break;
      case 'multi':
        if (!Array.isArray(v) || v.some((x) => !codesOf(item).includes(x))) push('Ungültige Auswahl.', 'typ');
        else if (new Set(v).size !== v.length) push('Doppelte Auswahl.', 'typ');
        break;
    }
    for (const val of item.validations ?? []) {
      if (!evaluateRule(val.rule, makeResolver(group, instanceId))) push(val.message, 'regel', val.severity ?? 'fehler');
    }
  };

  for (const section of schema.sections) {
    if (isSectionVisible(section)) visibleSections.push(section.id);
    for (const item of section.items) {
      if (item.type === 'group') {
        const inst = instances[item.id] ?? [];
        if (isVisible(item.id)) {
          visibleGroups.push(item.id);
          if (item.repeat && inst.length < item.repeat.min) {
            issues.push({ key: item.id, itemId: item.id, message: `Mindestens ${item.repeat.min} Eintrag/Einträge „${item.repeat.instanceLabel}“ erforderlich.`, severity: 'fehler', kind: 'gruppe' });
            requiredOpen++;
          }
          if (item.repeat && inst.length > item.repeat.max) {
            issues.push({ key: item.id, itemId: item.id, message: `Höchstens ${item.repeat.max} Einträge „${item.repeat.instanceLabel}“ zulässig.`, severity: 'fehler', kind: 'gruppe' });
          }
        }
        for (const instanceId of inst) for (const child of item.items ?? []) checkInput(child, item, instanceId);
      } else {
        checkInput(item);
      }
    }
  }

  const visibleSet = new Set(visibleKeys);
  const inactiveKeys = Object.keys(answers).filter((k) => isAnswered(answers[k]) && (!visibleSet.has(k) || !validKeys.has(k)));

  return { visibleKeys, visibleGroups, inactiveKeys, visibleSections, scores, issues, progress: { answered, total, requiredOpen } };
}

/** Blockierende Fehler für den bewussten Abschluss. */
export function blockingIssues(ev: FormEvaluation): Issue[] {
  return ev.issues.filter((i) => i.severity === 'fehler');
}

/** Kanonisches JSON (sortierte Schlüssel) – Grundlage für Hashes veröffentlichter Versionen. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
