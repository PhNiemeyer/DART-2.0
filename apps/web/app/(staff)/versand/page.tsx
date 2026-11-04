'use client';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  dead_letter: { label: 'Dead Letter', tone: 'bad' },
  unklar: { label: 'Zustellung unklar', tone: 'warn' },
  fehlgeschlagen: { label: 'Fehlgeschlagen', tone: 'warn' },
  ausstehend: { label: 'Ausstehend', tone: 'info' },
  in_versand: { label: 'In Versand', tone: 'info' },
  versendet: { label: 'Versendet', tone: 'ok' },
  storniert: { label: 'Storniert', tone: 'neutral' },
};
const KIND: Record<string, string> = { einladung: 'Einladung', erinnerung: 'Erinnerung', arzt_erinnerung: 'Arzt-Erinnerung', vor_ort_link: 'Link vor Ort' };
const CONTACT: Record<string, { label: string; tone: Tone }> = {
  aktiv: { label: 'E-Mail aktiv', tone: 'ok' },
  abgemeldet: { label: 'E-Mail abbestellt', tone: 'warn' },
  unzustellbar: { label: 'Adresse unzustellbar', tone: 'bad' },
};
const RESULT: Record<string, string> = { versendet: 'versendet', fehler: 'Fehler', unklar: 'unklar', storniert: 'storniert', abgeglichen: 'abgeglichen', unzustellbar: 'Empfänger abgewiesen' };
const FILTERS: Array<[string, string]> = [['probleme', 'Zu bearbeiten'], ['dead_letter', 'Dead Letter'], ['unklar', 'Unklar'], ['fehlgeschlagen', 'Fehlgeschlagen'], ['ausstehend', 'Ausstehend'], ['storniert', 'Storniert'], ['versendet', 'Versendet'], ['alle', 'Alle']];

function StatusBadge({ s }: { s: string }) {
  const x = STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
  return <Badge tone={x.tone}>{x.label}</Badge>;
}

function Detail({ id, onDone, onError }: { id: string; onDone: (m: string) => void; onError: (e: ApiErr) => void }) {
  const [d, setD] = useState<any>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { api(`/dispatch/${id}`).then(setD).catch(onError); }, [id, onError]);
  if (!d) return <Loading what="Versanddetails" />;
  async function act(action: 'requeue' | 'cancel' | 'reconcile') {
    try {
      await api(`/dispatch/${id}/${action}`, { body: action === 'reconcile' ? {} : { reason } });
      onDone(action === 'requeue' ? 'Nachricht erneut eingereiht. Die Einwilligung wird vor dem Versand erneut geprüft.' : action === 'cancel' ? 'Nachricht storniert.' : 'Abgleich angefordert. Der Versanddienst prüft beim Anbieter, ob die Nachricht bereits zugestellt wurde, bevor er erneut sendet.');
    } catch (e) {
      onError(e as ApiErr);
    }
  }
  const valid = reason.trim().length >= 3;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <dl className="kv">
        <dt>Fall</dt><dd><Link href={`/faelle/${d.case_id}`}>{d.case_no}</Link> · {d.pseudonym}{d.timepoint ? ` · Zeitpunkt ${d.timepoint}` : ''}</dd>
        <dt>Art / Stufe</dt><dd>{KIND[d.kind] ?? d.kind} · {d.stage}</dd>
        <dt>Versuche</dt><dd>{d.attempts} von {d.max_attempts}{d.status === 'fehlgeschlagen' ? ` · nächster automatischer Versuch ${fmtDateTime(d.next_attempt_at)}` : ''}</dd>
        <dt>Letzter Fehler</dt><dd>{d.last_error ?? '–'}</dd>
        {d.cancel_reason && <><dt>Stornogrund</dt><dd>{d.cancel_reason}</dd></>}
        {d.contact && <><dt>Kontaktstatus</dt><dd><Badge tone={CONTACT[d.contact.status].tone}>{CONTACT[d.contact.status].label}</Badge>{d.contact.reason ? ` – ${d.contact.reason}` : ''}</dd></>}
        {d.handled_at && <><dt>Zuletzt bearbeitet</dt><dd>{fmtDateTime(d.handled_at)}{d.handling_note ? ` – ${d.handling_note}` : ''}</dd></>}
      </dl>
      <div>
        <h3 className="small" style={{ margin: '0 0 4px' }}>Versandjournal dieser Nachricht</h3>
        {d.journal.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Noch kein Versuch protokolliert.</p> : (
          <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
            {d.journal.map((a: any) => <li key={a.attempt_no}>Versuch {a.attempt_no}: {RESULT[a.result] ?? a.result}{a.error_code ? ` (${a.error_code})` : ''} · {fmtDateTime(a.finished_at)}</li>)}
          </ol>
        )}
      </div>
      {d.contact && d.contact.status !== 'aktiv' && (
        <Alert kind="warning" title={CONTACT[d.contact.status].label}>
          {d.contact.status === 'abgemeldet' ? 'Die Person erhält keine E-Mail-Erinnerungen. Erneutes Einreihen ist gesperrt.' : 'Bitte E-Mail-Adresse prüfen bzw. korrigieren und den Kontakt im Fall wieder aktivieren; danach kann die Nachricht erneut eingereiht werden.'}{' '}
          <Link href={`/faelle/${d.case_id}#kontakt`}>Kontaktstatus im Fall öffnen</Link>
        </Alert>
      )}
      {(d.actions.requeue || d.actions.cancel) && (
        <div className="field">
          <label htmlFor={`gr-${id}`}>Grund der Bearbeitung (Pflicht, wird protokolliert)</label>
          <input id={`gr-${id}`} type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Mailserver wieder erreichbar" />
        </div>
      )}
      <div className="row">
        {d.actions.requeue && <button disabled={!valid} onClick={() => act('requeue')}>Erneut einreihen</button>}
        {d.actions.reconcile && <button className="btn-secondary" onClick={() => act('reconcile')}>Abgleich beim Anbieter anfordern</button>}
        {d.actions.cancel && <button className="btn-danger" disabled={!valid} onClick={() => act('cancel')}>Stornieren</button>}
        {!d.actions.requeue && !d.actions.cancel && !d.actions.reconcile && <span className="small muted">Für diesen Zustand ist keine Bearbeitung vorgesehen.</span>}
      </div>
      {d.actions.reconcile && <p className="small muted">Bei unklarer Zustellung wird nie blind erneut gesendet: Erst der Abgleich über die Message-ID entscheidet.</p>}
    </div>
  );
}

function CentralOverview({ rows }: { rows: Array<{ center_code: string; center_name: string; status: string; n: number }> }) {
  const centers = [...new Set(rows.map((r) => r.center_code))];
  const cols = ['dead_letter', 'unklar', 'fehlgeschlagen', 'ausstehend', 'versendet', 'storniert'];
  return (
    <section className="card" aria-labelledby="h-zentral">
      <h2 id="h-zentral">Übersicht aller Zentren</h2>
      <p className="small muted">Nur Anzahlen, ohne Patienten- oder Fallbezug. Die Bearbeitung erfolgt im jeweiligen Zentrum.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Zentrum</th>{cols.map((c) => <th key={c}>{STATUS[c].label}</th>)}</tr></thead>
          <tbody>
            {centers.length === 0 && <tr><td colSpan={cols.length + 1}>Keine Versandaufträge.</td></tr>}
            {centers.map((code) => {
              const r = rows.filter((x) => x.center_code === code);
              return <tr key={code}><td>{code} – {r[0].center_name}</td>{cols.map((c) => <td key={c} data-label={STATUS[c].label}>{r.find((x) => x.status === c)?.n ?? 0}</td>)}</tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Versand() {
  const me = useMe();
  const manage = can(me, 'dispatch.manage');
  const [summary, setSummary] = useState<any>(null);
  const [filter, setFilter] = useState('probleme');
  const [list, setList] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api('/dispatch/summary').then(setSummary).catch(setError);
    if (manage) api(`/dispatch?status=${filter}`).then(setList).catch(setError);
  }, [filter, manage]);
  useEffect(() => { load(); }, [load]);
  const count = (s: string) => summary?.byStatus?.find((r: any) => r.status === s)?.n ?? 0;
  const contacts = (s: string) => summary?.contacts?.find((r: any) => r.status === s)?.n ?? 0;
  return (
    <>
      <h1>Versand-Leitstand</h1>
      <ConceptNote />
      <p className="muted">Einladungen und Erinnerungen: Dead Letters, unklare Zustellungen, fehlgeschlagene Versuche und Abmeldungen bearbeiten. E-Mail-Adressen und Inhalte werden hier nicht angezeigt.</p>
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {!summary && !error && <Loading what="Versandübersicht" />}
      {summary?.ebene === 'zentral' && <CentralOverview rows={summary.byCenter} />}
      {summary?.ebene === 'zentrum' && (
        <section className="grid grid-3" aria-label="Kennzahlen Versand" style={{ marginBottom: 16 }}>
          {[['dead_letter', 'Dead Letters'], ['unklar', 'Zustellung unklar'], ['fehlgeschlagen', 'Fehlgeschlagen']].map(([k, l]) => (
            <button key={k} className="kpi" style={{ textAlign: 'left' }} onClick={() => setFilter(k)} aria-pressed={filter === k}><div className="num">{count(k)}</div><div>{l}</div></button>
          ))}
          <div className="kpi"><div className="num">{contacts('abgemeldet') + contacts('unzustellbar')}</div><div>Kontakte gesperrt ({contacts('abgemeldet')} abbestellt, {contacts('unzustellbar')} unzustellbar)</div></div>
        </section>
      )}
      {manage && (
        <section className="card" aria-labelledby="h-journal">
          <h2 id="h-journal">Versandjournal</h2>
          <div className="row no-print" role="group" aria-label="Filter nach Status">
            {FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'btn-small' : 'btn-ghost btn-small'} aria-pressed={filter === k} onClick={() => { setFilter(k); setOpen(null); }}>{l}</button>)}
          </div>
          {!list && <Loading what="Versandjournal" />}
          {list && list.items.length === 0 && <Alert kind="info" title="Nichts zu bearbeiten">Für diesen Filter liegen keine Versandaufträge vor.</Alert>}
          {list && list.items.length > 0 && (
            <>
              <p className="small muted">{list.total} Einträge{list.total > list.pageSize ? `, die ${list.pageSize} dringlichsten angezeigt` : ''}</p>
              <div className="table-wrap">
                <table className="cards">
                  <thead><tr><th>Status</th><th>Fall</th><th>Art</th><th style={{ whiteSpace: 'nowrap' }}>Versuche</th><th>Letzter Fehler / Grund</th><th>Aktualisiert</th><th><span className="sr-only">Aktion</span></th></tr></thead>
                  <tbody>
                    {list.items.map((it: any) => (
                      <Fragment key={it.id}>
                        <tr>
                          <td data-label="Status"><StatusBadge s={it.status} />{it.email_status !== 'aktiv' && it.kind !== 'arzt_erinnerung' && <div style={{ marginTop: 4 }}><Badge tone={CONTACT[it.email_status].tone}>{CONTACT[it.email_status].label}</Badge></div>}</td>
                          <td data-label="Fall" style={{ whiteSpace: 'nowrap' }}><strong>{it.case_no}</strong><div className="small muted">{it.pseudonym}{it.timepoint ? ` · ${it.timepoint}` : ''}</div></td>
                          <td data-label="Art" style={{ whiteSpace: 'nowrap' }}>{KIND[it.kind] ?? it.kind}</td>
                          <td data-label="Versuche" style={{ whiteSpace: 'nowrap' }}>{it.attempts}/{it.max_attempts}</td>
                          <td data-label="Fehler/Grund">{it.cancel_reason ?? it.last_error ?? '–'}</td>
                          <td data-label="Aktualisiert" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(it.updated_at)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}><button className="btn-ghost btn-small" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? 'Schließen' : 'Bearbeiten'}</button></td>
                        </tr>
                        {open === it.id && <tr><td colSpan={7}><Detail id={it.id} onError={setError} onDone={(m) => { setMsg(m); setOpen(null); load(); }} /></td></tr>}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
