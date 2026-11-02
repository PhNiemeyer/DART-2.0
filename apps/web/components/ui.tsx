'use client';
import { ReactNode } from 'react';

export function Alert({ kind = 'info', title, children }: { kind?: 'info' | 'error' | 'warning' | 'success'; title?: string; children?: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      {title && children ? <div>{children}</div> : children}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`badge ${tone === 'neutral' ? '' : `badge-${tone}`}`}>{children}</span>;
}

const CONSENT_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  gueltig: 'ok', vorbereitet: 'info', signatur_ausstehend: 'warn', upload_in_pruefung: 'warn', abgelehnt: 'bad', widerrufen: 'bad', erneuerung_erforderlich: 'warn', historisch_ungeklaert: 'warn', fehlt: 'bad',
};
const CONSENT_LABEL: Record<string, string> = {
  fehlt: 'Fehlt', vorbereitet: 'Vorbereitet', signatur_ausstehend: 'Signatur ausstehend', upload_in_pruefung: 'Upload in Prüfung', gueltig: 'Gültig', abgelehnt: 'Abgelehnt', widerrufen: 'Widerrufen', erneuerung_erforderlich: 'Erneute Einwilligung erforderlich', historisch_ungeklaert: 'Historisch ungeklärt',
};
export function ConsentBadge({ status }: { status: string | null }) {
  const s = status ?? 'fehlt';
  return <Badge tone={CONSENT_TONE[s] ?? 'neutral'}>Einwilligung: {CONSENT_LABEL[s] ?? s}</Badge>;
}

const EVENT_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = { abgeschlossen: 'ok', eingeladen: 'info', begonnen: 'info', geplant: 'neutral', ueberfaellig: 'warn', abgebrochen: 'bad', gesperrt: 'bad' };
const EVENT_LABEL: Record<string, string> = { geplant: 'geplant', eingeladen: 'eingeladen', begonnen: 'begonnen', abgeschlossen: 'abgeschlossen', ueberfaellig: 'überfällig', abgebrochen: 'abgebrochen', gesperrt: 'gesperrt' };
export function EventBadge({ status }: { status: string }) {
  return <Badge tone={EVENT_TONE[status] ?? 'neutral'}>{EVENT_LABEL[status] ?? status}</Badge>;
}

export function Loading({ what = 'Daten' }: { what?: string }) {
  return <p className="muted" role="status" aria-live="polite">{what} werden geladen …</p>;
}

export function ErrorBox({ error, onRetry }: { error: { message: string; status?: number; body?: any } | null; onRetry?: () => void }) {
  if (!error) return null;
  const details: Array<{ path: string; message: string }> = error.body?.details ?? [];
  const noRights = error.status === 403;
  return (
    <Alert kind="error" title={noRights ? 'Keine Berechtigung' : 'Fehler'}>
      <p style={{ margin: 0 }}>{error.message}</p>
      {details.length > 0 && <ul>{details.slice(0, 12).map((d, i) => <li key={i}>{d.message}{d.path ? <span className="muted small"> ({d.path})</span> : null}</li>)}</ul>}
      {error.body?.request_id && <p className="small muted" style={{ margin: '6px 0 0' }}>Vorgangsnummer: {error.body.request_id}</p>}
      {onRetry && <button className="btn-ghost btn-small" onClick={onRetry} style={{ marginTop: 8 }}>Erneut versuchen</button>}
    </Alert>
  );
}

export function ConceptNote() {
  return <p className="label-concept">Prototyp · synthetische Daten · keine Echtdaten</p>;
}
