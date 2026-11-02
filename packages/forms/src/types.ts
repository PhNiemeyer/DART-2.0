/**
 * Versioniertes Formularschema (JSON). Medizinische Inhalte sind Daten, kein Code:
 * neue Bögen benötigen keinen Programmdeploy, neue Feldtypen schon (F08).
 */

export type ItemType =
  | 'text'
  | 'number'
  | 'date'
  | 'single'
  | 'multi'
  | 'yesno'
  | 'computed'
  | 'group';

export const ITEM_TYPES: readonly ItemType[] = [
  'text',
  'number',
  'date',
  'single',
  'multi',
  'yesno',
  'computed',
  'group',
];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  text: 'Freitext',
  number: 'Zahl',
  date: 'Datum',
  single: 'Einfachauswahl',
  multi: 'Mehrfachauswahl',
  yesno: 'Ja/Nein/Unbekannt',
  computed: 'Berechnet (nur lesen)',
  group: 'Wiederholbare Gruppe',
};

/** Ja/Nein mit explizitem „unbekannt“ – keine stille Nein-Vorbelegung. */
export const YESNO_CODES = [
  { code: 'ja', label: 'Ja' },
  { code: 'nein', label: 'Nein' },
  { code: 'unbekannt', label: 'Unbekannt' },
] as const;

export interface Code {
  code: string;
  label: string;
}

/** Zulässige Fehlgründe (MissingReason). Stabil kodiert, deutsch beschriftet. */
export type MissingCode =
  | 'nicht_erhoben'
  | 'nicht_zutreffend'
  | 'unbekannt'
  | 'verweigert'
  | 'historisch_leer';

export const MISSING_CODES: Record<MissingCode, string> = {
  nicht_erhoben: 'Nicht erhoben',
  nicht_zutreffend: 'Nicht zutreffend',
  unbekannt: 'Unbekannt',
  verweigert: 'Angabe verweigert',
  historisch_leer: 'Historisch leer (Altbestand, ohne Beleg)',
};

/** Operand einer Regel: Variablenreferenz oder Literal. */
export type Operand = { var: string } | string | number | boolean | null;

/**
 * Deklarative Regel-DSL (F09). Ausschließlich Whitelist-Operatoren,
 * kein eval, kein beliebiger JavaScript-Code.
 */
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { eq: [Operand, Operand] }
  | { in: [Operand, Array<string | number | boolean>] }
  | { exists: string }
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] };

export const RULE_OPERATORS = ['all', 'any', 'not', 'eq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte'] as const;

export interface ValidationRule {
  /** Muss zu true auswerten, sonst wird die Meldung angezeigt. */
  rule: Rule;
  message: string;
  /** 'fehler' blockiert den Abschluss, 'hinweis' nicht (Plausibilität). */
  severity?: 'fehler' | 'hinweis';
}

export interface ComputeSpec {
  /** Referenz auf versionierten Scorealgorithmus, z. B. "DEMO-SCORE@1". */
  algorithm: string;
  /** Eingangsvariablen (Item-IDs). */
  inputs: string[];
}

export interface FormItem {
  /** Stabile Item-ID innerhalb des Formulars. */
  id: string;
  /** Stabile Variablenkennung (VariableConcept), versionsübergreifend. */
  varId: string;
  label: string;
  help?: string;
  type: ItemType;
  unit?: string;
  /** Messmethode, z. B. für DEKOR-Messwerte. */
  method?: string;
  codes?: Code[];
  required?: boolean;
  min?: number;
  max?: number;
  decimals?: number;
  visibleIf?: Rule;
  validations?: ValidationRule[];
  /** Zulässige Fehlgründe statt eines Wertes. */
  allowedMissing?: MissingCode[];
  /** Nur für type=group: Kinder und Wiederholungsgrenzen. */
  items?: FormItem[];
  repeat?: { min: number; max: number; instanceLabel: string };
  /** Nur für type=computed. */
  compute?: ComputeSpec;
}

export interface FormSection {
  id: string;
  title: string;
  /** Fachliches Modul, dem der Abschnitt angehört (Basis, Knorpel, …). */
  module?: string;
  visibleIf?: Rule;
  items: FormItem[];
}

export interface FormSchema {
  schemaVersion: 1;
  code: string;
  title: string;
  audience: 'arzt' | 'patient';
  module: string;
  description?: string;
  sections: FormSection[];
}

/** Ein Antwortwert. Genau ein Wert oder ein Fehlgrund. */
export interface AnswerValue {
  value?: string | number | string[] | null;
  missing?: MissingCode | null;
}

/**
 * Antwortschlüssel: itemId für einfache Items, `${groupId}[${instanceId}].${itemId}`
 * für Items in wiederholbaren Gruppen. Instanzkennungen sind stabil (UUID o. ä.).
 */
export type AnswerMap = Record<string, AnswerValue>;

export interface GroupInstances {
  /** groupId -> geordnete stabile Instanzkennungen */
  [groupId: string]: string[];
}

export interface ResponseData {
  answers: AnswerMap;
  instances: GroupInstances;
}

export function answerKey(itemId: string, groupId?: string, instanceId?: string): string {
  return groupId && instanceId ? `${groupId}[${instanceId}].${itemId}` : itemId;
}

export function parseAnswerKey(key: string): { itemId: string; groupId?: string; instanceId?: string } {
  const m = /^([^[\]]+)\[([^\]]+)\]\.(.+)$/.exec(key);
  if (m) return { groupId: m[1], instanceId: m[2], itemId: m[3] };
  return { itemId: key };
}
