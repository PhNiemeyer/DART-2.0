import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT erwartet');
const uuid = z.string().uuid('Ungültige Kennung');

/** Fehlercodes mit deutscher Standardmeldung (T01). */
export const ERROR_CODES = {
  VALIDIERUNG: 'Die Eingaben sind unvollständig oder ungültig.',
  NICHT_ANGEMELDET: 'Bitte melden Sie sich an.',
  KEINE_BERECHTIGUNG: 'Für diese Aktion fehlt die Berechtigung.',
  NICHT_GEFUNDEN: 'Der Datensatz wurde nicht gefunden oder ist für Sie nicht zugänglich.',
  KONFLIKT: 'Der Datensatz wurde inzwischen geändert. Bitte prüfen Sie die Unterschiede.',
  REVISION_FEHLT: 'Die Revision (If-Match) fehlt.',
  CONSENT_FEHLT: 'Die Erfassung ist gesperrt: Es liegt keine gültige Einwilligung im benötigten Umfang vor.',
  SCIENCE_NICHT_FREIGEGEBEN: 'DART Science ist für dieses Zentrum nicht freigegeben.',
  ZUSTAND_UNZULAESSIG: 'Dieser Schritt ist im aktuellen Zustand nicht zulässig.',
  VIER_AUGEN: 'Vier-Augen-Prinzip: Die eigene Arbeit kann nicht selbst freigegeben werden.',
  SCHEMA_UNGUELTIG: 'Das Formularschema ist ungültig.',
  VERSION_UNVERAENDERLICH: 'Veröffentlichte Versionen sind unveränderlich.',
  UPLOAD_ABGELEHNT: 'Die Datei wurde abgelehnt.',
  TOKEN_UNGUELTIG: 'Der Einladungslink ist ungültig, abgelaufen oder bereits verwendet.',
  ZU_VIELE_VERSUCHE: 'Zu viele Versuche. Bitte fordern Sie einen neuen Zugang an.',
  IDEMPOTENZ_KONFLIKT: 'Der Idempotency-Key wurde bereits für eine andere Anfrage verwendet.',
  INTERN: 'Ein interner Fehler ist aufgetreten. Bitte versuchen Sie es erneut.',
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiError {
  code: ErrorCode;
  message: string;
  request_id: string;
  details?: Array<{ path: string; message: string }>;
}

export const CreatePatientCaseSchema = z.object({
  patient: z.union([
    z.object({ existingPatientId: uuid }),
    z.object({
      firstName: z.string().trim().min(1, 'Vorname fehlt').max(100),
      lastName: z.string().trim().min(1, 'Nachname fehlt').max(100),
      email: z.string().trim().email('Ungültige E-Mail-Adresse').max(200).optional().or(z.literal('')),
      birthDate: isoDate.optional().or(z.literal('')),
    }),
  ]),
  centerId: uuid,
  joint: z.enum(['knie', 'schulter', 'huefte', 'sprunggelenk']),
  side: z.enum(['links', 'rechts']),
  treatmentType: z.enum(['operativ', 'konservativ']),
  surgeonUserId: uuid.optional().nullable(),
  plannedOpDate: isoDate.optional().nullable(),
  actualOpDate: isoDate.optional().nullable(),
  conservativeStartDate: isoDate.optional().nullable(),
  mode: z.enum(['basic', 'science']),
  registers: z.array(z.enum(['DART', 'KNORPEL_DGOU', 'DEKOR'])).min(1),
  modules: z.array(z.string().max(40)).max(10),
  procedures: z.array(z.object({ code: z.string().max(20), version: z.string().max(40), concept: z.string().max(60) })).max(20),
}).superRefine((v, ctx) => {
  if (v.treatmentType === 'operativ' && !v.plannedOpDate && !v.actualOpDate) ctx.addIssue({ code: 'custom', path: ['plannedOpDate'], message: 'Für operative Behandlung ist ein geplantes oder tatsächliches OP-Datum erforderlich' });
  if (v.treatmentType === 'konservativ' && !v.conservativeStartDate) ctx.addIssue({ code: 'custom', path: ['conservativeStartDate'], message: 'Für konservative Behandlung ist ein Behandlungsbeginn erforderlich' });
  if (!v.registers.includes('DART')) ctx.addIssue({ code: 'custom', path: ['registers'], message: 'Die Registerzugehörigkeit DART ist für Kniefälle erforderlich' });
});
export type CreatePatientCase = z.infer<typeof CreatePatientCaseSchema>;

export const AnswerValueSchema = z.object({
  value: z.union([z.string().max(4000), z.number(), z.array(z.string().max(100)).max(100), z.null()]).optional(),
  missing: z.enum(['nicht_erhoben', 'nicht_zutreffend', 'unbekannt', 'verweigert', 'historisch_leer']).nullable().optional(),
});

export const PatchDraftSchema = z.object({
  answers: z.record(z.string().max(200), AnswerValueSchema),
  instances: z.record(z.string().max(64), z.array(z.string().max(64)).max(50)).optional(),
});

export const ReasonSchema = z.object({ reason: z.string().trim().min(5, 'Bitte eine Begründung (mind. 5 Zeichen) angeben').max(1000) });

export const ConsentPrepareSchema = z.object({
  patientId: uuid,
  documentVersionId: uuid,
  scopes: z.array(z.enum(['register_basic', 'science', 'knorpelregister', 'dekor', 'kontakt_followup'])).min(1),
  method: z.enum(['digital_demo', 'papier_upload']),
  informedBy: z.string().trim().min(1).max(200).optional(),
});

export const PortalConsentSchema = z.object({
  acceptedScopes: z.array(z.enum(['register_basic', 'science', 'knorpelregister', 'dekor', 'kontakt_followup'])),
  confirmRead: z.literal(true, { message: 'Bitte bestätigen Sie, dass Sie die Information gelesen haben' }),
  signature: z.union([
    z.object({ kind: z.literal('gezeichnet'), pngDataUrl: z.string().max(400_000).regex(/^data:image\/png;base64,/) }),
    z.object({ kind: z.literal('getippt'), typedName: z.string().trim().min(3).max(200) }),
  ]),
  signedDate: isoDate,
});

export const PaperReviewSchema = z.object({
  decision: z.enum(['gueltig', 'abgelehnt']),
  checklist: z.object({ richtige_person: z.boolean(), vollstaendig: z.boolean(), richtige_version: z.boolean(), unterschrift_vorhanden: z.boolean() }),
  signedDate: isoDate.optional(),
  rejectionReason: z.string().trim().max(1000).optional(),
});

export const ExportRequestSchema = z.object({
  purpose: z.string().trim().min(10, 'Zweck bitte konkret beschreiben (mind. 10 Zeichen)').max(2000),
  scope: z.enum(['basic', 'science']),
  centerIds: z.array(uuid).optional(),
  periodFrom: isoDate,
  periodTo: isoDate,
  layers: z.array(z.enum(['normalisiert', 'scores'])).min(1),
});

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(100).optional(),
  centerId: uuid.optional(),
  surgeonId: uuid.optional(),
  register: z.string().max(40).optional(),
  joint: z.string().max(40).optional(),
  module: z.string().max(40).optional(),
  procedure: z.string().max(60).optional(),
  mode: z.enum(['basic', 'science']).optional(),
  status: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export { z };
