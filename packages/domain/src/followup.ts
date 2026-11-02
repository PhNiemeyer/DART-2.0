/**
 * Follow-up-Planung (F16/F17). Datumswerte ohne Uhrzeit als ISO-Datum (YYYY-MM-DD),
 * Versandzeitpunkte als UTC-Zeitstempel, berechnet aus Ortszeit Europe/Berlin.
 */

export interface PlanTimepoint {
  code: string;
  label: string;
  months: number;
  optional?: boolean;
  /** historisch: wird nicht neu geplant, bleibt aber lesbar (z. B. FU3). */
  historicOnly?: boolean;
}

export interface FollowUpPlanVersion {
  code: string;
  version: number;
  status: 'vorschlag' | 'freigegeben';
  timepoints: PlanTimepoint[];
  window: { beforeDays: number; afterDays: number };
  reminders: { patientDays: number[]; physicianDaysAfterPlannedOp: number };
  sendHourLocal: number;
  timezone: string;
  note: string;
}

export const FOLLOWUP_PLAN_V1: FollowUpPlanVersion = {
  code: 'FU-PLAN-KNIE',
  version: 1,
  status: 'vorschlag',
  timepoints: [
    { code: 'BL', label: 'Baseline', months: 0 },
    { code: 'M6', label: '6 Monate', months: 6 },
    { code: 'M12', label: '12 Monate', months: 12 },
    { code: 'M24', label: '24 Monate', months: 24 },
    { code: 'M36', label: '36 Monate', months: 36 },
    { code: 'M60', label: '60 Monate', months: 60 },
    { code: 'M120', label: '120 Monate (optional)', months: 120, optional: true },
  ],
  window: { beforeDays: 14, afterDays: 60 },
  reminders: { patientDays: [7, 12], physicianDaysAfterPlannedOp: 3 },
  sendHourLocal: 9,
  timezone: 'Europe/Berlin',
  note: 'Vorläufige Vorgaben aus Blatt „Neuanlage“; vor Pilot fachlich freizugeben.',
};

/** Historische Zeitpunkte, die nicht mehr neu geplant werden (z. B. FU3). */
export const HISTORIC_TIMEPOINTS: PlanTimepoint[] = [{ code: 'FU3', label: 'FU3 (historisch)', months: -1, historicOnly: true }];

export function parseIsoDate(d: string): { y: number; m: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Ungültiges Datum: ${d}`);
  return { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) };
}

export function formatIsoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Kalendarische Monatsaddition mit Monatsende-Klemmung (31.01. + 1 Monat = 28./29.02.). */
export function addMonths(date: string, months: number): string {
  const { y, m, day } = parseIsoDate(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return formatIsoDate(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export function addDays(date: string, days: number): string {
  const { y, m, day } = parseIsoDate(date);
  const dt = new Date(Date.UTC(y, m - 1, day + days));
  return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Offset einer IANA-Zeitzone zu einem UTC-Zeitpunkt in Minuten. */
function tzOffsetMinutes(utc: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUtc - utc.getTime()) / 60000;
}

/** Ortszeit (Datum + Stunde) in einer Zeitzone → UTC-Zeitpunkt; sommerzeitfest. */
export function localTimeToUtc(date: string, hour: number, timeZone = 'Europe/Berlin'): Date {
  const { y, m, day } = parseIsoDate(date);
  const guess = Date.UTC(y, m - 1, day, hour, 0, 0);
  let off = tzOffsetMinutes(new Date(guess), timeZone);
  let ts = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(ts), timeZone);
  if (off2 !== off) {
    off = off2;
    ts = guess - off * 60000;
  }
  return new Date(ts);
}

/** UTC-Zeitpunkt → Kalenderdatum in Europe/Berlin. */
export function utcToLocalDate(ts: Date, timeZone = 'Europe/Berlin'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  return parts;
}

export interface CaseDates {
  treatmentType: 'operativ' | 'konservativ';
  plannedOpDate?: string | null;
  actualOpDate?: string | null;
  conservativeStartDate?: string | null;
}

/**
 * Bezugsdatum: tatsächliches OP-Datum, sonst geplantes OP-Datum (vorläufig);
 * konservative Behandlung: eigenes Bezugsdatum, kein fiktives OP-Datum.
 */
export function referenceDate(c: CaseDates): { date: string | null; kind: 'op_tatsaechlich' | 'op_geplant' | 'konservativ' | 'fehlt' } {
  if (c.treatmentType === 'konservativ') return c.conservativeStartDate ? { date: c.conservativeStartDate, kind: 'konservativ' } : { date: null, kind: 'fehlt' };
  if (c.actualOpDate) return { date: c.actualOpDate, kind: 'op_tatsaechlich' };
  if (c.plannedOpDate) return { date: c.plannedOpDate, kind: 'op_geplant' };
  return { date: null, kind: 'fehlt' };
}

export interface PlannedEvent {
  timepoint: string;
  label: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  optional: boolean;
}

export function planEvents(refDate: string, plan: FollowUpPlanVersion = FOLLOWUP_PLAN_V1, includeOptional = false): PlannedEvent[] {
  return plan.timepoints
    .filter((t) => includeOptional || !t.optional)
    .map((t) => {
      const due = addMonths(refDate, t.months);
      return {
        timepoint: t.code,
        label: t.label,
        dueDate: due,
        // Baseline: Fenster vor dem Bezugsdatum (präoperative Befragung)
        windowStart: addDays(due, -plan.window.beforeDays),
        windowEnd: addDays(due, plan.window.afterDays),
        optional: !!t.optional,
      };
    });
}

/** Erinnerungszeitpunkte relativ zur Einladung (Tage), jeweils 09:00 Ortszeit. */
export function reminderTimes(invitedAt: Date, plan: FollowUpPlanVersion = FOLLOWUP_PLAN_V1): Array<{ stage: number; at: Date }> {
  const invitedLocal = utcToLocalDate(invitedAt, plan.timezone);
  return plan.reminders.patientDays.map((d, i) => ({ stage: i + 1, at: localTimeToUtc(addDays(invitedLocal, d), plan.sendHourLocal, plan.timezone) }));
}

export type EventStatus = 'geplant' | 'eingeladen' | 'begonnen' | 'abgeschlossen' | 'ueberfaellig' | 'abgebrochen' | 'gesperrt';

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  geplant: 'geplant',
  eingeladen: 'eingeladen',
  begonnen: 'begonnen',
  abgeschlossen: 'abgeschlossen',
  ueberfaellig: 'überfällig',
  abgebrochen: 'abgebrochen',
  gesperrt: 'gesperrt',
};

/** Abgeleiteter Anzeigestatus (überfällig, wenn Fenster abgelaufen und nicht abgeschlossen). */
export function displayStatus(stored: EventStatus, windowEnd: string, today: string): EventStatus {
  if (['abgeschlossen', 'abgebrochen', 'gesperrt'].includes(stored)) return stored;
  if (windowEnd < today) return 'ueberfaellig';
  return stored;
}

/** Idempotenzschlüssel für Einladung/Erinnerung: Fall, Ereignis, Regelversion, Stufe (F17). */
export function reminderIdempotencyKey(p: { caseId: string; eventId: string; ruleVersion: string; stage: string | number }): string {
  return `${p.caseId}:${p.eventId}:${p.ruleVersion}:${p.stage}`;
}

/** Exponentielles Backoff für Versandwiederholungen (Sekunden), gedeckelt. */
export function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 6 * 3600);
}
