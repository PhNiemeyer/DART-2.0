'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDateTime, todayIso } from '@/lib/format';
import { Alert, ConceptNote, ErrorBox, Loading } from '@/components/ui';
import { DateInput } from '@/components/DateInput';

const CHECKS: Array<[string, string]> = [
  ['richtige_person', 'Dokument gehört zur richtigen Person'],
  ['vollstaendig', 'Dokument ist vollständig (alle Seiten)'],
  ['richtige_version', 'Dokumentversion stimmt überein'],
  ['unterschrift_vorhanden', 'Unterschrift und Datum sind vorhanden'],
];

function Review({ item, onDone, onError }: { item: any; onDone: (m: string) => void; onError: (e: ApiErr) => void }) {
  const [chk, setChk] = useState<Record<string, boolean>>({});
  const [signedDate, setSignedDate] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const all = CHECKS.every(([k]) => chk[k]);
  async function open() {
    const res = await fetch(`/api/v1/consents/${item.id}/evidence/file`, { cache: 'no-store' });
    if (!res.ok) return onError(new ApiErr(res.status, 'FEHLER', 'Nachweis konnte nicht geladen werden', null));
    const blob = await res.blob();
    setPreview(URL.createObjectURL(blob));
  }
  async function decide(decision: 'gueltig' | 'abgelehnt') {
    try {
      await api(`/consents/${item.id}/review`, { body: { decision, checklist: Object.fromEntries(CHECKS.map(([k]) => [k, !!chk[k]])), signedDate: signedDate || undefined, rejectionReason: reason || undefined } });
      onDone(decision === 'gueltig' ? 'Nachweis als gültig bestätigt. Die Erfassung ist freigegeben.' : 'Nachweis abgelehnt. Ein erneuter Upload ist möglich.');
    } catch (e) {
      onError(e as ApiErr);
    }
  }
  return (
    <section className="card">
      <h2>{item.pseudonym} {item.case_id && <Link className="small" href={`/faelle/${item.case_id}`}>Fall öffnen</Link>}</h2>
      <p className="small muted">{item.document_title} · Version {item.document_version} · hochgeladen {fmtDateTime(item.uploaded_at)} · Umfang: {item.scopes.join(', ')}</p>
      <div className="row"><button className="btn-ghost btn-small" onClick={open}>Nachweis ansehen</button>{preview && <a className="btn-ghost btn-small btn" href={preview} target="_blank" rel="noreferrer">In neuem Tab öffnen</a>}</div>
      {preview && <iframe title="Vorschau des Nachweises" src={preview} style={{ width: '100%', height: 360, border: '1px solid var(--border)', borderRadius: 10, marginTop: 8 }} />}
      <fieldset style={{ marginTop: 12 }}>
        <legend>Sichtprüfung</legend>
        {CHECKS.map(([k, l]) => <label key={k} className="choice"><input type="checkbox" checked={!!chk[k]} onChange={(e) => setChk({ ...chk, [k]: e.target.checked })} />{l}</label>)}
      </fieldset>
      <div className="grid grid-2">
        <div className="field"><label htmlFor={`sd-${item.id}`}>Unterschriftsdatum laut Dokument</label><DateInput id={`sd-${item.id}`} max={todayIso()} value={signedDate} onChange={(iso) => setSignedDate(iso)} /></div>
        <div className="field"><label htmlFor={`rr-${item.id}`}>Ablehnungsgrund (bei Ablehnung)</label><input id={`rr-${item.id}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <div className="row">
        <button disabled={!all || !signedDate} onClick={() => decide('gueltig')}>Als gültig bestätigen</button>
        <button className="btn-danger" disabled={reason.trim().length < 5} onClick={() => decide('abgelehnt')}>Ablehnen</button>
      </div>
      <p className="small muted">Unterschriftsdatum, Uploadzeit und Prüfzeit werden getrennt gespeichert.</p>
    </section>
  );
}

export default function Evidence() {
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api('/consents/review-queue').then((r) => setItems(r.items)).catch(setError), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <h1>Nachweise prüfen</h1>
      <ConceptNote />
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {!items && !error && <Loading what="Nachweise" />}
      {items?.length === 0 && <Alert kind="info" title="Keine offenen Nachweise">Derzeit wartet kein hochgeladener Nachweis auf Prüfung.</Alert>}
      {items?.map((it) => <Review key={it.id} item={it} onDone={(m) => { setMsg(m); void load(); }} onError={setError} />)}
    </>
  );
}
