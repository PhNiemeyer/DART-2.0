/**
 * Einwilligung als prüfbarer Prozess (F11–F15).
 * Ein Upload oder eine Arzt-Checkbox allein macht den Status NICHT gültig.
 */

export type ConsentStatus =
  | 'fehlt'
  | 'vorbereitet'
  | 'signatur_ausstehend'
  | 'upload_in_pruefung'
  | 'gueltig'
  | 'abgelehnt'
  | 'widerrufen'
  | 'erneuerung_erforderlich'
  | 'historisch_ungeklaert';

export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = {
  fehlt: 'Fehlt',
  vorbereitet: 'Vorbereitet',
  signatur_ausstehend: 'Signatur ausstehend',
  upload_in_pruefung: 'Upload in Prüfung',
  gueltig: 'Gültig',
  abgelehnt: 'Abgelehnt',
  widerrufen: 'Widerrufen',
  erneuerung_erforderlich: 'Erneute Einwilligung erforderlich',
  historisch_ungeklaert: 'Historisch ungeklärt',
};

export type ConsentMethod = 'digital_demo' | 'papier_upload' | 'altbestand';

export const CONSENT_METHOD_LABELS: Record<ConsentMethod, string> = {
  digital_demo: 'Digitale Signatur (DEMONSTRATION – keine QES)',
  papier_upload: 'Upload einer handschriftlich unterschriebenen Erklärung',
  altbestand: 'Altbestand (Nachweis unbekannt)',
};

/** Zweck-/Registerumfang. Science verlangt ausdrücklich den Scope „science“. */
export type ConsentScope = 'register_basic' | 'science' | 'knorpelregister' | 'dekor' | 'kontakt_followup';

export const CONSENT_SCOPE_LABELS: Record<ConsentScope, string> = {
  register_basic: 'Teilnahme am Register DART (Basisdokumentation)',
  science: 'Wissenschaftliche Auswertung (DART Science)',
  knorpelregister: 'Übermittlung an das KnorpelRegister DGOU',
  dekor: 'Teilnahme am DEKOR-Modul',
  kontakt_followup: 'Kontaktaufnahme per E-Mail für Verlaufsbefragungen',
};

export const ALL_SCOPES = Object.keys(CONSENT_SCOPE_LABELS) as ConsentScope[];

/** Erlaubte Zustandsübergänge. Alles andere wird serverseitig abgelehnt. */
export const CONSENT_TRANSITIONS: Record<ConsentStatus, ConsentStatus[]> = {
  fehlt: ['vorbereitet'],
  vorbereitet: ['signatur_ausstehend', 'upload_in_pruefung', 'abgelehnt'],
  signatur_ausstehend: ['gueltig', 'abgelehnt', 'vorbereitet'],
  upload_in_pruefung: ['gueltig', 'abgelehnt'],
  gueltig: ['widerrufen', 'erneuerung_erforderlich'],
  abgelehnt: ['vorbereitet'],
  widerrufen: [],
  erneuerung_erforderlich: ['vorbereitet', 'widerrufen'],
  historisch_ungeklaert: ['vorbereitet', 'widerrufen'],
};

export function canTransition(from: ConsentStatus, to: ConsentStatus): boolean {
  return CONSENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ConsentLike {
  status: ConsentStatus;
  scopes: string[];
}

/**
 * Gate: medizinische Erfassung/Befragung/Versand nur bei gültiger Einwilligung
 * mit allen benötigten Scopes.
 */
export function consentAllows(records: ConsentLike[], required: ConsentScope[]): { ok: boolean; reason?: string } {
  const valid = records.filter((r) => r.status === 'gueltig');
  if (valid.length === 0) {
    const blocking = records.find((r) => ['widerrufen', 'abgelehnt', 'historisch_ungeklaert', 'erneuerung_erforderlich', 'upload_in_pruefung', 'signatur_ausstehend'].includes(r.status));
    return { ok: false, reason: blocking ? `Einwilligung: ${CONSENT_STATUS_LABELS[blocking.status]}` : 'Keine gültige Einwilligung vorhanden' };
  }
  const scopes = new Set(valid.flatMap((r) => r.scopes));
  const missing = required.filter((s) => !scopes.has(s));
  if (missing.length) return { ok: false, reason: `Einwilligungsumfang fehlt: ${missing.map((m) => CONSENT_SCOPE_LABELS[m]).join(', ')}` };
  return { ok: true };
}

/** Benötigte Scopes für einen Fall abhängig von Modus und Registern. */
export function requiredScopesForCase(mode: 'basic' | 'science', registers: string[]): ConsentScope[] {
  const s: ConsentScope[] = ['register_basic'];
  if (mode === 'science') s.push('science');
  if (registers.includes('KNORPEL_DGOU')) s.push('knorpelregister');
  if (registers.includes('DEKOR')) s.push('dekor');
  return s;
}

/** Sichtprüfung eines Papiernachweises – alle Punkte müssen bestätigt sein. */
export interface PaperReviewChecklist {
  richtige_person: boolean;
  vollstaendig: boolean;
  richtige_version: boolean;
  unterschrift_vorhanden: boolean;
}

export const PAPER_REVIEW_LABELS: Record<keyof PaperReviewChecklist, string> = {
  richtige_person: 'Dokument gehört zur richtigen Person',
  vollstaendig: 'Dokument ist vollständig (alle Seiten)',
  richtige_version: 'Dokumentversion stimmt mit der gewählten Version überein',
  unterschrift_vorhanden: 'Unterschrift und Datum sind vorhanden',
};

export function checklistComplete(c: Partial<PaperReviewChecklist>): boolean {
  return (Object.keys(PAPER_REVIEW_LABELS) as Array<keyof PaperReviewChecklist>).every((k) => c[k] === true);
}
