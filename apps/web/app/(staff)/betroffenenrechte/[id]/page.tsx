'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { DSR_CHANNEL, DSR_EVENT, DSR_IDENTITY, DSR_KIND, DSR_STATUS } from '@/lib/dsr';
import { CONSENT_SCOPE_LABELS, CONSENT_STATUS_LABELS } from '@dart/domain';
import { fmtDate, fmtDateTime, OUTBOX_STATUS_LABEL, RESPONSE_STATUS_LABEL } from '@/lib/format';

const KIND_LABEL: Record<string, string> = { einladung: 'Einladung', erinnerung: 'Erinnerung', arzt_erinnerung: 'Erinnerung an das Zentrum', vor_ort_link: 'Link vor Ort' };
const MAIL_LABEL: Record<string, string> = { aktiv: 'aktiv', abgemeldet: 'abbestellt', unzustellbar: 'Adresse unzustellbar' };
const SEX_LABEL: Record<string, string> = { weiblich: 'weiblich', maennlich: 'männlich', divers: 'divers', unbekannt: 'unbekannt' };
const scope = (s: string) => (CONSENT_SCOPE_LABELS as Record<string, string>)[s] ?? s;
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

function ReasonAction({ id, label, button, danger, onSubmit }: { id: string; label: string; button: string; danger?: boolean; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <form className="grid" onSubmit={(e) => { e.preventDefault(); void onSubmit(reason).then(() => setReason('')); }}>
      <div className="field"><label htmlFor={id}>{label}</label><input id={id} type="text" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <div><button type="submit" className={danger ? 'btn-danger' : 'btn-secondary'} disabled={reason.trim().length < 5}>{button}</button></div>
    </form>
  );
}

function Auskunft({ data }: { data: any }) {
  return (
    <section className="card print-block" aria-labelledby="h-ausk">
      <h2 id="h-ausk">{data.titel}</h2>
      <p className="small muted">Stand: {fmtDateTime(data.stichtag)} · {data.hinweis}</p>
      <h3>Identität (Identity Vault)</h3>
      <dl className="kv">
        {data.identitaet.vorname !== undefined ? (
          <><dt>Name</dt><dd>{data.identitaet.vorname} {data.identitaet.nachname}</dd><dt>Geburtsdatum</dt><dd>{fmtDate(data.identitaet.geburtsdatum)}</dd><dt>E-Mail</dt><dd>{data.identitaet.email ?? '–'}</dd></>
        ) : <><dt>Hinweis</dt><dd>{data.identitaet.hinweis}</dd></>}
        <dt>Pseudonym</dt><dd>{data.pseudonym}</dd>
        <dt>Geschlecht</dt><dd>{data.geschlecht ? SEX_LABEL[data.geschlecht] ?? data.geschlecht : 'nicht erfasst'}</dd>
        <dt>Verarbeitung eingeschränkt</dt><dd>{data.eingeschraenkt ? 'ja' : 'nein'}</dd>
      </dl>
      <h3>Behandlungsfälle ({data.faelle.length})</h3>
      <ul>{data.faelle.map((f: any) => <li key={f.case_no}>{f.case_no}: Knie {f.side}, {f.treatment_type}, {f.zentrum}, Modus {f.modus}, Register {f.register.join(', ')}{f.module.length ? `, Module ${f.module.join(', ')}` : ''}{f.actual_op_date || f.planned_op_date ? `, OP ${fmtDate(f.actual_op_date ?? f.planned_op_date)}` : ''}</li>)}</ul>
      <h3>Einwilligungen ({data.einwilligungen.length})</h3>
      <ul>{data.einwilligungen.map((c: any, i: number) => <li key={i}>{c.title ?? 'Einwilligung'} {c.version ? `(Version ${c.version})` : ''}: {(CONSENT_STATUS_LABELS as Record<string, string>)[c.status] ?? c.status}; Umfang: {c.scopes.map(scope).join(', ')}{c.signed_date ? `, unterschrieben ${fmtDate(c.signed_date)}` : ''}</li>)}</ul>
      <h3>Bögen ({data.boegen.length})</h3>
      {data.boegen.length === 0 && <p className="muted">Keine Bögen.</p>}
      {data.boegen.map((b: any, i: number) => (
        <details key={i}>
          <summary>{b.fall} · {b.zeitpunkt ?? '–'} · {b.formular} · {RESPONSE_STATUS_LABEL[b.status] ?? b.status} ({b.antworten.length} Angaben)</summary>
          <ul className="small">{b.antworten.map((a: any, j: number) => <li key={j}>{a.frage}: {String(a.wert ?? '–')}</li>)}</ul>
          {b.scores.length > 0 && <p className="small">Scores: {b.scores.map((s: any) => `${s.verfahren} = ${s.wert ?? '–'}`).join('; ')}</p>}
        </details>
      ))}
      <h3>Kontakt und Versand</h3>
      <p>E-Mail-Erinnerungen: {MAIL_LABEL[data.kontaktEmail?.email_status ?? 'aktiv']}</p>
      <ul>{data.versand.length === 0 ? <li>Keine Nachrichten</li> : data.versand.map((v: any, i: number) => <li key={i}>{KIND_LABEL[v.kind] ?? v.kind}: {v.n} × {OUTBOX_STATUS_LABEL[v.status] ?? v.status}</li>)}</ul>
      <p>Protokollierte Zugriffe und Änderungen (Fachaudit): {data.protokollierteZugriffe}</p>
      <button className="btn-ghost no-print" onClick={() => window.print()}>Drucken / als PDF speichern</button>
    </section>
  );
}

export default function DsrDetail() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [method, setMethod] = useState('');
  const [report, setReport] = useState<any>(null);
  const [overview, setOverview] = useState<any>(null);
  const [close, setClose] = useState({ result: 'erledigt', outcome: '', confirm: false });

  const load = useCallback(() => api(`/dsr/${id}`).then((r) => { setD(r); setError(null); }).catch(setError), [id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (path: string, body: unknown, ok: string) => {
    try {
      await api(`/dsr/${id}/${path}`, { body });
      setMsg(ok);
      await load();
    } catch (e) {
      setError(e as ApiErr);
      throw e;
    }
  };

  if (!d) return error ? <ErrorBox error={error} /> : <Loading what="Antrag" />;
  const open = ['offen', 'in_bearbeitung'].includes(d.status);
  const overdue = open && d.frist < new Date().toISOString().slice(0, 10);
  return (
    <>
      <p className="small no-print"><Link href="/betroffenenrechte">← Alle Anträge</Link></p>
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>{DSR_KIND[d.kind]}</h1>
        <Badge tone={DSR_STATUS[d.status].tone}>{DSR_STATUS[d.status].label}</Badge>
      </div>
      <ConceptNote />
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {overdue && <Alert kind="error" title="Frist überschritten">Die Frist ist am {fmtDate(d.frist)} abgelaufen. Bitte vorrangig bearbeiten und die Verzögerung begründen.</Alert>}
      {d.restriction && <Alert kind="warning" title="Verarbeitung eingeschränkt">Seit {fmtDateTime(d.restriction.at)}: {d.restriction.reason}. Keine Exporte, Auswertungen oder Einladungen.</Alert>}

      <section className="card" aria-labelledby="h-ant">
        <h2 id="h-ant">Antrag</h2>
        <dl className="kv">
          <dt>Fall</dt><dd>{d.caseId ? <Link href={`/faelle/${d.caseId}`}>{d.caseNo}</Link> : '–'} · {d.pseudonym}</dd>
          <dt>Eingang</dt><dd>{fmtDate(d.receivedAt)} ({DSR_CHANNEL[d.channel]})</dd>
          <dt>Frist</dt><dd>{fmtDate(d.frist)}{d.extendedDueDate ? ` (verlängert von ${fmtDate(d.dueDate)}: ${d.extensionReason})` : ' (ein Monat ab Eingang)'}</dd>
          <dt>Identität</dt><dd>{d.identity ? `${DSR_IDENTITY[d.identity.method]}, ${fmtDateTime(d.identity.at)}` : 'noch nicht geprüft'}</dd>
          {d.note && <><dt>Anliegen</dt><dd>{d.note}</dd></>}
          {d.outcome && <><dt>Ergebnis</dt><dd>{d.outcome} ({fmtDateTime(d.closedAt)})</dd></>}
        </dl>
      </section>

      {open && (
        <section className="card no-print" aria-labelledby="h-bear">
          <h2 id="h-bear">Bearbeitung</h2>
          {!d.actions.close && <p className="muted">Die Bearbeitung erfolgt durch die Zentrumsverantwortlichen.</p>}
          {d.actions.identity && (
            <form className="grid" onSubmit={(e) => { e.preventDefault(); void act('identity', { method }, 'Identitätsprüfung dokumentiert.').catch(() => undefined); }}>
              <div className="field">
                <label htmlFor="idm">1. Identität prüfen</label>
                <select id="idm" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="">– Verfahren wählen –</option>
                  {Object.entries(DSR_IDENTITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <div className="help">Ein E-Mail-Link allein reicht nicht als Identitätsnachweis.</div>
              </div>
              <div><button type="submit" className="btn-secondary" disabled={!method}>Identität als geprüft dokumentieren</button></div>
            </form>
          )}
          {d.actions.report && !report && <p><button className="btn-secondary" onClick={() => api(`/dsr/${id}/auskunft`).then((r) => { setReport(r); void load(); }).catch(setError)}>Auskunft zusammenstellen (protokolliert)</button></p>}
          {d.actions.deletionOverview && !overview && <p><button className="btn-secondary" onClick={() => api(`/dsr/${id}/loeschuebersicht`).then(setOverview).catch(setError)}>Löschübersicht je Datenklasse anzeigen</button></p>}
          {d.actions.restrict && <ReasonAction id="rs" label={d.kind === 'loeschung' ? 'Sofortsperre bis zur Löschung – Begründung' : 'Verarbeitung einschränken – Begründung'} button="Verarbeitung einschränken" danger onSubmit={(r) => act('restrict', { reason: r }, 'Verarbeitung eingeschränkt. Offene Einladungen wurden storniert.')} />}
          {d.actions.lift && <ReasonAction id="lf" label="Einschränkung aufheben – Begründung" button="Einschränkung aufheben" onSubmit={(r) => act('lift', { reason: r }, 'Einschränkung aufgehoben.')} />}
          {d.actions.extend && (
            <details>
              <summary>Frist einmalig um zwei Monate verlängern</summary>
              <ReasonAction id="ex" label="Begründung (z. B. Komplexität, Anzahl der Anträge); die Person ist innerhalb der Frist zu informieren" button="Frist verlängern" onSubmit={(r) => act('extend', { reason: r }, 'Frist verlängert.')} />
            </details>
          )}
          {d.actions.close && (
            <fieldset style={{ marginTop: 12 }}>
              <legend>Abschluss</legend>
              <div className="row">
                <label className="choice"><input type="radio" name="res" checked={close.result === 'erledigt'} onChange={() => setClose({ ...close, result: 'erledigt' })} />Erledigt</label>
                <label className="choice"><input type="radio" name="res" checked={close.result === 'abgelehnt'} onChange={() => setClose({ ...close, result: 'abgelehnt' })} />Abgelehnt</label>
              </div>
              <div className="field"><label htmlFor="oc">{close.result === 'erledigt' ? 'Ergebnis (was wurde wann mitgeteilt bzw. geändert?)' : 'Begründung der Ablehnung'}</label><textarea id="oc" rows={3} maxLength={2000} value={close.outcome} onChange={(e) => setClose({ ...close, outcome: e.target.value })} /></div>
              {d.kind === 'loeschung' && close.result === 'erledigt' && (
                <label className="choice"><input type="checkbox" checked={close.confirm} onChange={(e) => setClose({ ...close, confirm: e.target.checked })} />Die Löschung wurde nach freigegebener Lösch-/Aufbewahrungsmatrix manuell durchgeführt und dokumentiert.</label>
              )}
              <button className={close.result === 'abgelehnt' ? 'btn-danger' : ''} disabled={close.outcome.trim().length < 5 || (close.result === 'erledigt' && !d.identity)} onClick={() => act('close', { result: close.result, outcome: close.outcome, manualDeletionConfirmed: close.confirm || undefined }, close.result === 'erledigt' ? 'Antrag abgeschlossen.' : 'Antrag abgelehnt.').catch(() => undefined)}>
                {close.result === 'erledigt' ? 'Als erledigt abschließen' : 'Ablehnen'}
              </button>
              {close.result === 'erledigt' && !d.identity && <p className="small muted">Erst nach Identitätsprüfung möglich.</p>}
            </fieldset>
          )}
        </section>
      )}

      {overview && (
        <section className="card" aria-labelledby="h-loe">
          <h2 id="h-loe">Löschübersicht je Datenklasse</h2>
          <Alert kind="warning">{overview.hinweis}</Alert>
          {!overview.eingeschraenkt && <p className="small">Empfehlung: Verarbeitung sofort einschränken, bis die Löschung durchgeführt ist.</p>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Datenklasse</th><th>Anzahl</th><th>Ort</th><th>Vorschlag (nicht freigegeben)</th><th>Entscheidung</th></tr></thead>
              <tbody>{overview.klassen.map((k: any) => <tr key={k.klasse}><td>{k.klasse}</td><td>{k.anzahl ?? '–'}</td><td>{k.ort}</td><td>{k.vorschlag}</td><td>{k.entscheidung}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      {report && <Auskunft data={report} />}

      <section className="card" aria-labelledby="h-verl">
        <h2 id="h-verl">Verlauf (unveränderlich)</h2>
        <ol className="small">{d.events.map((e: any, i: number) => <li key={i}>{fmtDateTime(e.created_at)} · {DSR_EVENT[e.action] ?? e.action} · {e.actor ?? '–'}{e.detail ? ` – ${e.detail}` : ''}</li>)}</ol>
      </section>
    </>
  );
}
