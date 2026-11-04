/**
 * Rollen, Register, Module, Zuordnungsmatrix und Beispielkatalog.
 * Alle medizinischen Inhalte sind BEISPIELE/VORSCHLÄGE und fachlich freizugeben.
 */

export type Role =
  | 'zentrale_admin'
  | 'zentrumsverantwortlich'
  | 'arzt'
  | 'dokumentation'
  | 'datenmanagement'
  | 'formularredaktion'
  | 'formularfreigabe'
  | 'forschung'
  | 'technik';

export const ROLE_LABELS: Record<Role, string> = {
  zentrale_admin: 'Zentrale Administration',
  zentrumsverantwortlich: 'Zentrumsverantwortliche/r',
  arzt: 'Arzt/Ärztin',
  dokumentation: 'Dokumentationskraft',
  datenmanagement: 'Datenmanagement',
  formularredaktion: 'Formularredaktion',
  formularfreigabe: 'Formularfreigabe',
  forschung: 'Forschung',
  technik: 'Technischer Betrieb',
};

/** Rollen, die zentrumsgebunden sind (benötigen center_id). */
export const CENTER_ROLES: Role[] = ['zentrumsverantwortlich', 'arzt', 'dokumentation', 'datenmanagement'];

export type Permission =
  | 'case.read'
  | 'case.write'
  | 'case.finalize'
  | 'identity.read'
  | 'identity.write'
  | 'consent.manage'
  | 'consent.review'
  | 'form.read'
  | 'form.draft'
  | 'form.publish'
  | 'report.read'
  | 'export.request'
  | 'export.approve'
  | 'migration.run'
  | 'admin.manage'
  | 'audit.read'
  | 'dispatch.manage'
  | 'dispatch.overview';

/** Rollenmatrix (Lastenheft Kap. 12). Technischer Betrieb: keine fachlichen Rechte. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  zentrale_admin: ['admin.manage', 'audit.read', 'export.approve', 'form.read', 'dispatch.overview'],
  zentrumsverantwortlich: ['case.read', 'case.write', 'identity.read', 'consent.review', 'report.read', 'form.read', 'dispatch.manage'],
  arzt: ['case.read', 'case.write', 'case.finalize', 'identity.read', 'identity.write', 'consent.manage', 'consent.review', 'report.read', 'form.read'],
  dokumentation: ['case.read', 'case.write', 'identity.read', 'identity.write', 'consent.manage', 'form.read', 'dispatch.manage'],
  datenmanagement: ['case.read', 'report.read', 'export.request', 'migration.run', 'form.read'],
  formularredaktion: ['form.read', 'form.draft'],
  formularfreigabe: ['form.read', 'form.publish'],
  forschung: ['export.request'],
  technik: [],
};

export function hasPermission(roles: Role[], p: Permission): boolean {
  return roles.some((r) => ROLE_PERMISSIONS[r]?.includes(p));
}

export type CaptureMode = 'basic' | 'science';
export const MODE_LABELS: Record<CaptureMode, string> = { basic: 'DART Basic', science: 'DART Science' };

export type Joint = 'knie' | 'schulter' | 'huefte' | 'sprunggelenk';
export const JOINTS: Record<Joint, { label: string; enabled: boolean }> = {
  knie: { label: 'Knie', enabled: true },
  schulter: { label: 'Schulter (vorbereitet)', enabled: false },
  huefte: { label: 'Hüfte (vorbereitet)', enabled: false },
  sprunggelenk: { label: 'Sprunggelenk (vorbereitet)', enabled: false },
};

export const SIDES: Record<string, string> = { links: 'Links', rechts: 'Rechts' };
export const TREATMENT_TYPES: Record<string, string> = { operativ: 'Operative Behandlung', konservativ: 'Konservative Behandlung' };

export const REGISTERS: Record<string, string> = {
  DART: 'DART (Deutschsprachiges Arthroskopieregister)',
  KNORPEL_DGOU: 'KnorpelRegister DGOU',
  DEKOR: 'DEKOR',
};

export interface ModuleDef {
  code: string;
  label: string;
  joint: Joint;
  /** Register, die das Modul typischerweise voraussetzt bzw. nahelegt. */
  suggestsRegister?: string;
  basis?: boolean;
}

export const MODULES: ModuleDef[] = [
  { code: 'MENISKUS', label: 'Meniskus', joint: 'knie' },
  { code: 'KREUZBAND', label: 'VKB/HKB', joint: 'knie' },
  { code: 'PATELLA', label: 'Patella', joint: 'knie' },
  { code: 'KNORPEL', label: 'Knorpel', joint: 'knie', suggestsRegister: 'KNORPEL_DGOU' },
  { code: 'OSTEOTOMIE', label: 'Osteotomie', joint: 'knie', suggestsRegister: 'DEKOR' },
  { code: 'ENDOPROTHETIK', label: 'Endoprothetik', joint: 'knie' },
  { code: 'SYNOVITIS', label: 'Synovitis', joint: 'knie' },
  { code: 'PATELLASEHNE_KONS', label: 'Konservative Patellasehnentherapie', joint: 'knie' },
];

export const MODULE_LABELS: Record<string, string> = Object.fromEntries([
  ['BASIS', 'Basis'],
  ...MODULES.map((m) => [m.code, m.label]),
]);

/** Zeile der versionierten Zuordnungsmatrix (F07). '*' = beliebig. */
export interface AssignmentRule {
  register: string;
  joint: Joint | '*';
  mode: CaptureMode | '*';
  module: string;
  treatment: 'operativ' | 'konservativ' | '*';
  role: 'arzt' | 'patient';
  timepoint: 'BL' | 'FU' | '*';
  questionnaire: string;
}

export interface AssignmentMatrixVersion {
  code: string;
  version: number;
  status: 'vorschlag' | 'freigegeben';
  validFrom: string;
  rules: AssignmentRule[];
}

/**
 * Zuordnungsmatrix V1 – VORSCHLAG für den Prototyp. Die vollständige Basic/Science-Matrix
 * der Patientenbögen ist gesondert freizugeben (docs/entscheidungen.md, E-03).
 */
export const ASSIGNMENT_MATRIX_V1: AssignmentMatrixVersion = {
  code: 'ZUORDNUNG-KNIE',
  version: 1,
  status: 'vorschlag',
  validFrom: '2026-01-01',
  rules: [
    { register: 'DART', joint: 'knie', mode: 'basic', module: 'BASIS', treatment: '*', role: 'arzt', timepoint: 'BL', questionnaire: 'KNIE-BASIC-ARZT' },
    { register: 'DART', joint: 'knie', mode: 'science', module: 'BASIS', treatment: '*', role: 'arzt', timepoint: 'BL', questionnaire: 'KNIE-BA-ARZT' },
    { register: 'DART', joint: 'knie', mode: '*', module: 'BASIS', treatment: '*', role: 'patient', timepoint: '*', questionnaire: 'KNIE-PAT' },
    // Aus V05 abgeleitete Instrumente (Scoring Freigabe ausstehend, E-09)
    { register: 'DART', joint: 'knie', mode: '*', module: 'BASIS', treatment: '*', role: 'patient', timepoint: '*', questionnaire: 'KNIE-IKDC' },
    { register: 'DART', joint: 'knie', mode: '*', module: 'BASIS', treatment: '*', role: 'patient', timepoint: '*', questionnaire: 'KNIE-KOOS' },
    { register: '*', joint: 'knie', mode: '*', module: 'KNORPEL', treatment: 'operativ', role: 'arzt', timepoint: 'BL', questionnaire: 'KNIE-KNORPEL-ARZT' },
    { register: '*', joint: 'knie', mode: '*', module: 'OSTEOTOMIE', treatment: 'operativ', role: 'arzt', timepoint: 'BL', questionnaire: 'DEKOR-OSTEOTOMIE-ARZT' },
    { register: '*', joint: 'knie', mode: '*', module: 'MENISKUS', treatment: '*', role: 'arzt', timepoint: 'BL', questionnaire: 'KNIE-MENISKUS-ARZT' },
  ],
};

export interface CaseForAssignment {
  joint: Joint;
  mode: CaptureMode;
  treatment: 'operativ' | 'konservativ';
  registers: string[];
  modules: string[];
}

/**
 * Ermittelt die Bögen eines Falls. Die Basis erscheint je Version nur einmal,
 * auch wenn mehrere Module/Register aktiv sind.
 */
export function resolveQuestionnaires(
  c: CaseForAssignment,
  role: 'arzt' | 'patient',
  timepoint: 'BL' | 'FU',
  matrix: AssignmentMatrixVersion = ASSIGNMENT_MATRIX_V1,
): Array<{ questionnaire: string; module: string }> {
  const modules = ['BASIS', ...c.modules];
  const out = new Map<string, { questionnaire: string; module: string }>();
  for (const r of matrix.rules) {
    if (r.role !== role) continue;
    if (r.joint !== '*' && r.joint !== c.joint) continue;
    if (r.mode !== '*' && r.mode !== c.mode) continue;
    if (r.treatment !== '*' && r.treatment !== c.treatment) continue;
    if (r.timepoint !== '*' && r.timepoint !== timepoint) continue;
    if (r.register !== '*' && !c.registers.includes(r.register)) continue;
    if (!modules.includes(r.module)) continue;
    if (!out.has(r.questionnaire)) out.set(r.questionnaire, { questionnaire: r.questionnaire, module: r.module });
  }
  return [...out.values()];
}

/**
 * Beispielkatalog OPS (vereinfachte Kodierebene). Codes und Bezeichnungen sind vor dem Pilot
 * gegen die amtliche OPS-Version des BfArM zu prüfen. Gleiche Codes können unterschiedliche
 * Eingriffskonzepte bezeichnen – daher wird stets das Konzept mitgespeichert.
 */
export interface OpsEntry {
  code: string;
  version: string;
  concept: string;
  label: string;
  module?: string;
}

export const OPS_EXAMPLE_VERSION = 'OPS-BEISPIEL-2026';

export const OPS_EXAMPLES: OpsEntry[] = [
  { code: '5-812', version: OPS_EXAMPLE_VERSION, concept: 'MENISKUS_TEILRESEKTION', label: 'Arthroskopische Meniskusteilresektion (Beispiel)', module: 'MENISKUS' },
  { code: '5-812', version: OPS_EXAMPLE_VERSION, concept: 'KNORPEL_GLAETTUNG', label: 'Arthroskopische Knorpelglättung (Beispiel)', module: 'KNORPEL' },
  { code: '5-812', version: OPS_EXAMPLE_VERSION, concept: 'MIKROFRAKTURIERUNG', label: 'Knochenmarkstimulation/Mikrofrakturierung (Beispiel)', module: 'KNORPEL' },
  { code: '5-801', version: OPS_EXAMPLE_VERSION, concept: 'KNORPEL_ZELLTRANSPLANTATION', label: 'Knorpelzelltransplantation, offen (Beispiel)', module: 'KNORPEL' },
  { code: '5-813', version: OPS_EXAMPLE_VERSION, concept: 'VKB_PLASTIK', label: 'Plastik des vorderen Kreuzbands (Beispiel)', module: 'KREUZBAND' },
  { code: '5-813', version: OPS_EXAMPLE_VERSION, concept: 'HKB_PLASTIK', label: 'Plastik des hinteren Kreuzbands (Beispiel)', module: 'KREUZBAND' },
  { code: '5-813', version: OPS_EXAMPLE_VERSION, concept: 'MPFL_REKONSTRUKTION', label: 'Rekonstruktion des medialen patellofemoralen Bandes (Beispiel)', module: 'PATELLA' },
  { code: '5-781', version: OPS_EXAMPLE_VERSION, concept: 'TIBIAKOPF_OSTEOTOMIE', label: 'Valgisierende Tibiakopfosteotomie (Beispiel)', module: 'OSTEOTOMIE' },
  { code: '5-781', version: OPS_EXAMPLE_VERSION, concept: 'FEMUR_OSTEOTOMIE', label: 'Distale Femurosteotomie (Beispiel)', module: 'OSTEOTOMIE' },
  { code: '5-822', version: OPS_EXAMPLE_VERSION, concept: 'KNIE_ENDOPROTHESE', label: 'Implantation einer Knieendoprothese (Beispiel)', module: 'ENDOPROTHETIK' },
  { code: '5-811', version: OPS_EXAMPLE_VERSION, concept: 'SYNOVEKTOMIE', label: 'Arthroskopische Synovektomie (Beispiel)', module: 'SYNOVITIS' },
];
