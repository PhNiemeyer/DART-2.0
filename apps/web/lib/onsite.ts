'use client';
/** Einmalige Übergabe von Vor-Ort-Link und Zugangscode zwischen Seiten – nur im Arbeitsspeicher, nie im Browser-Storage. */
export interface Onsite { portalLink: string; token: string; accessCode: string; expiresInMinutes: number }
let pending: { caseId: string; onsite: Onsite } | null = null;
export function stashOnsite(caseId: string, onsite: Onsite) {
  pending = { caseId, onsite };
}
export function takeOnsite(caseId: string): Onsite | null {
  if (pending?.caseId !== caseId) return null;
  const o = pending.onsite;
  pending = null;
  return o;
}
