/** Bezeichnungen für Betroffenenrechte (R-19). */
export const DSR_KIND: Record<string, string> = {
  auskunft: 'Auskunft (Art. 15)',
  berichtigung: 'Berichtigung (Art. 16)',
  einschraenkung: 'Einschränkung (Art. 18)',
  widerruf: 'Widerruf der Einwilligung',
  loeschung: 'Löschung (Art. 17)',
};
export const DSR_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  offen: { label: 'Offen', tone: 'info' },
  in_bearbeitung: { label: 'In Bearbeitung', tone: 'info' },
  erledigt: { label: 'Erledigt', tone: 'ok' },
  abgelehnt: { label: 'Abgelehnt', tone: 'neutral' },
};
export const DSR_CHANNEL: Record<string, string> = { schriftlich: 'schriftlich', persoenlich: 'persönlich', telefonisch: 'telefonisch', email: 'per E-Mail', portal: 'über das Portal' };
export const DSR_IDENTITY: Record<string, string> = {
  persoenlich_ausweis: 'Persönlich mit Ausweis',
  portal_zugangscode: 'Portal mit persönlichem Zugangscode',
  schriftlich_unterschrift: 'Schriftlich mit Unterschriftenabgleich',
  rueckruf_bekannte_nummer: 'Rückruf unter bekannter Nummer',
};
export const DSR_EVENT: Record<string, string> = {
  erfasst: 'Antrag erfasst',
  identitaet_geprueft: 'Identität geprüft',
  frist_verlaengert: 'Frist verlängert',
  verarbeitung_eingeschraenkt: 'Verarbeitung eingeschränkt',
  einschraenkung_aufgehoben: 'Einschränkung aufgehoben',
  auskunft_erstellt: 'Auskunft erstellt',
  abgeschlossen: 'Abgeschlossen (erledigt)',
  abgelehnt: 'Abgelehnt',
};

/** Fristtext mit Tagen; überfällige Fristen deutlich als Text, nicht nur farblich. */
export function fristText(tage: number | null, offen: boolean): { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (!offen || tage === null) return { text: '–', tone: 'neutral' };
  if (tage < 0) return { text: `überfällig seit ${-tage} Tag(en)`, tone: 'bad' };
  if (tage === 0) return { text: 'heute fällig', tone: 'warn' };
  if (tage <= 7) return { text: `noch ${tage} Tag(e)`, tone: 'warn' };
  return { text: `noch ${tage} Tage`, tone: 'ok' };
}
