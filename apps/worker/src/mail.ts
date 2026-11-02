import nodemailer from 'nodemailer';

/**
 * Austauschbarer Versandanbieter. find() ermöglicht den Abgleich bei unklarem Ergebnis
 * (z. B. Zeitüberschreitung nach Übergabe), damit nicht blind doppelt gesendet wird.
 */
export interface OutgoingMail {
  messageId: string;
  to: string;
  subject: string;
  text: string;
}

export class SendError extends Error {
  /** 'abgelehnt' = sicher nicht zugestellt; 'unklar' = Ergebnis unbekannt (Abgleich nötig) */
  constructor(public readonly kind: 'abgelehnt' | 'unklar', message: string) {
    super(message);
  }
}

export interface MailProvider {
  name: string;
  send(m: OutgoingMail): Promise<{ providerId: string }>;
  find(messageId: string): Promise<string | null>;
}

export function smtpProvider(opts: { host: string; port: number; from: string; mailpitApi?: string }): MailProvider {
  const transport = nodemailer.createTransport({ host: opts.host, port: opts.port, secure: false, connectionTimeout: 10_000, socketTimeout: 20_000 });
  return {
    name: `smtp:${opts.host}`,
    async send(m) {
      try {
        const info = await transport.sendMail({
          from: opts.from,
          to: m.to,
          subject: m.subject,
          text: m.text,
          messageId: m.messageId,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
        return { providerId: info.messageId ?? m.messageId };
      } catch (e) {
        const code = (e as { code?: string; responseCode?: number }).code;
        const rc = (e as { responseCode?: number }).responseCode;
        // Verbindungsfehler vor der Übergabe: sicher nicht gesendet. Zeitüberschreitung danach: unklar.
        if (code === 'ECONNREFUSED' || code === 'ESOCKET' || code === 'EDNS' || (rc && rc >= 500)) throw new SendError('abgelehnt', `${code ?? rc}`);
        throw new SendError('unklar', `${code ?? 'unbekannt'}`);
      }
    },
    async find(messageId) {
      if (!opts.mailpitApi) return null;
      // Abgleich über die Mailpit-API (lokal). Produktiv: Provider-Status-API.
      const id = messageId.replace(/^<|>$/g, '');
      const res = await fetch(`${opts.mailpitApi}/api/v1/search?query=${encodeURIComponent(`message-id:"${id}"`)}`);
      if (!res.ok) throw new SendError('unklar', `Abgleich nicht möglich (${res.status})`);
      const body = (await res.json()) as { messages?: Array<{ ID: string; MessageID: string }> };
      const hit = body.messages?.find((x) => x.MessageID === id);
      return hit ? hit.ID : null;
    },
  };
}

/** Deutschsprachige, datensparsame Texte: keine Diagnose, kein Anhang, kein Trackingpixel. */
export function inviteText(p: { link: string; reminder: boolean; resend: boolean }): { subject: string; text: string } {
  const subject = p.reminder ? 'Erinnerung: Ihre Befragung im Register' : 'Einladung zu Ihrer Befragung im Register';
  const text = [
    'Guten Tag,',
    '',
    p.reminder
      ? 'wir möchten Sie freundlich an Ihre Befragung erinnern. Ihre Teilnahme ist weiterhin freiwillig.'
      : p.resend
        ? 'wie gewünscht erhalten Sie einen neuen persönlichen Link zu Ihrer Befragung.'
        : 'Sie sind eingeladen, an Ihrer Befragung im Register teilzunehmen. Die Teilnahme ist freiwillig.',
    '',
    'Bitte öffnen Sie diesen persönlichen Link und bestätigen Sie den Zugang auf der Seite:',
    p.link,
    '',
    'Halten Sie bitte Ihren persönlichen Zugangscode bereit, den Sie in Ihrem Zentrum erhalten haben.',
    'Der Link ist nur für Sie bestimmt, einmalig verwendbar und zeitlich begrenzt.',
    '',
    'Sie können Ihre Einwilligung jederzeit im Patientenportal oder bei Ihrem Zentrum widerrufen.',
    '',
    '— Diese Nachricht wurde automatisch erstellt (DART 2.0 Prototyp, nur synthetische Daten).',
  ].join('\n');
  return { subject, text };
}

export function physicianText(p: { caseNo: string; open: number; webUrl: string }): { subject: string; text: string } {
  return {
    subject: `Offene Arztbögen für Fall ${p.caseNo}`,
    text: [
      'Guten Tag,',
      '',
      `für den Fall ${p.caseNo} sind noch ${p.open} Arztbogen/Arztbögen nicht abgeschlossen.`,
      `Bitte melden Sie sich an: ${p.webUrl}`,
      '',
      '— Automatische Erinnerung (DART 2.0 Prototyp, nur synthetische Daten).',
    ].join('\n'),
  };
}
