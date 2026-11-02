'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDate, todayIso } from '@/lib/format';
import { SignaturePad } from '@/components/SignaturePad';
import { Alert, Badge, ErrorBox, EventBadge, Loading } from '@/components/ui';

const TP: Record<string, string> = { BL: 'Erstbefragung', M6: 'nach 6 Monaten', M12: 'nach 12 Monaten', M24: 'nach 24 Monaten', M36: 'nach 36 Monaten', M60: 'nach 60 Monaten', M120: 'nach 120 Monaten' };

function ConsentForm({ c, onDone, onError }: { c: any; onDone: () => void; onError: (e: ApiErr) => void }) {
  const [accepted, setAccepted] = useState<string[]>([]);
  const [read, setRead] = useState(false);
  const [mode, setMode] = useState<'gezeichnet' | 'getippt'>('gezeichnet');
  const [png, setPng] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState(1);
  const offered = c.document.scopes.filter((s: any) => c.scopes.includes(s.code));
  const sigOk = mode === 'gezeichnet' ? !!png : typed.trim().length >= 3;
  async function send(decline = false) {
    try {
      await api(`/portal/consents/${c.id}/sign`, {
        body: { acceptedScopes: decline ? [] : accepted, confirmRead: true, signature: mode === 'gezeichnet' && png ? { kind: 'gezeichnet', pngDataUrl: png } : { kind: 'getippt', typedName: typed || 'Teilnahme abgelehnt' }, signedDate: todayIso() },
      });
      onDone();
    } catch (e) {
      onError(e as ApiErr);
    }
  }
  return (
    <section className="card" aria-labelledby="ct">
      <h2 id="ct">Ihre Teilnahme am Register</h2>
      <ol className="steps" aria-label="Schritte"><li aria-current={step === 1 ? 'step' : undefined}>1 Information</li><li aria-current={step === 2 ? 'step' : undefined}>2 Unterschrift</li><li aria-current={step === 3 ? 'step' : undefined}>3 Start</li></ol>
      {step === 1 && (
        <>
          <h3>{c.document.title}</h3>
          <p className="small muted">Version {c.document.version}{c.document.isDemo ? ' · Demonstrationstext' : ''}</p>
          <div className="consent-text" tabIndex={0} aria-label="Informationstext">{c.document.body}</div>
          <label className="choice" style={{ marginTop: 12 }}><input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />Ich habe die Information gelesen und hatte Gelegenheit, Fragen zu stellen.</label>
          <button disabled={!read} onClick={() => setStep(2)}>Weiter</button>
        </>
      )}
      {step === 2 && (
        <>
          <fieldset>
            <legend>Wozu stimmen Sie zu? (nichts ist vorausgewählt)</legend>
            {offered.map((s: any) => (
              <label key={s.code} className="choice"><input type="checkbox" checked={accepted.includes(s.code)} onChange={(e) => setAccepted(e.target.checked ? [...accepted, s.code] : accepted.filter((x) => x !== s.code))} />{s.label}</label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Unterschrift (Demonstration – keine qualifizierte elektronische Signatur)</legend>
            <div className="choice-row" style={{ marginBottom: 8 }}>
              <label className="choice"><input type="radio" name="sm" checked={mode === 'gezeichnet'} onChange={() => setMode('gezeichnet')} />Zeichnen</label>
              <label className="choice"><input type="radio" name="sm" checked={mode === 'getippt'} onChange={() => setMode('getippt')} />Namen eintippen</label>
            </div>
            {mode === 'gezeichnet' ? <SignaturePad onChange={setPng} /> : (
              <div className="field"><label htmlFor="tn">Vor- und Nachname</label><input id="tn" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
            )}
            <p className="small muted" style={{ margin: 0 }}>Datum: {fmtDate(todayIso())}</p>
          </fieldset>
          {!accepted.includes('register_basic') && accepted.length > 0 && <Alert kind="warning">Ohne Zustimmung zur Registerteilnahme kann keine Teilnahme erfolgen.</Alert>}
          <div className="row between">
            <button className="btn-ghost" onClick={() => setStep(1)}>Zurück</button>
            <div className="row">
              <button className="btn-ghost" onClick={() => send(true)}>Nicht teilnehmen</button>
              <button disabled={!sigOk || !accepted.includes('register_basic')} onClick={() => send()}>Prüfen und bestätigen</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default function Portal() {
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [copy, setCopy] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmW, setConfirmW] = useState<string | null>(null);
  const load = useCallback(() => api('/portal/me').then((r) => { setMe(r); setError(null); }).catch(setError), []);
  useEffect(() => { void load(); }, [load]);

  if (error && !me) return <><h1>Patientenportal</h1><ErrorBox error={error} /></>;
  if (!me) return <Loading what="Ihre Angaben" />;
  const pending = me.consents.find((c: any) => c.status === 'signatur_ausstehend');
  const valid = me.consents.filter((c: any) => c.status === 'gueltig');

  return (
    <>
      <h1>Willkommen</h1>
      <p className="muted small">Ihre Kennung: {me.pseudonym}</p>
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {pending && <ConsentForm c={pending} onDone={() => { setMsg('Vielen Dank. Ihre Einwilligung wurde gespeichert. Eine Kopie können Sie jederzeit abrufen.'); void load(); }} onError={setError} />}

      <section className="card" aria-labelledby="h-st">
        <h2 id="h-st">Nachweis und Status</h2>
        {me.consents.length === 0 && <p>Es liegt keine Einwilligung vor.</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {me.consents.map((c: any) => (
            <li key={c.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
              <Badge tone={c.status === 'gueltig' ? 'ok' : c.status === 'widerrufen' || c.status === 'abgelehnt' ? 'bad' : 'warn'}>{c.statusLabel}</Badge>
              {c.signedDate && <span className="small"> · unterschrieben am {fmtDate(c.signedDate)}</span>}
              <div className="row" style={{ marginTop: 6 }}>
                {['gueltig', 'widerrufen'].includes(c.status) && <button className="btn-ghost btn-small" onClick={() => api(`/portal/consents/${c.id}/copy`).then(setCopy).catch(setError)}>Kopie anzeigen</button>}
                {c.status === 'gueltig' && confirmW !== c.id && <button className="btn-ghost btn-small" onClick={() => setConfirmW(c.id)}>Einwilligung widerrufen</button>}
              </div>
              {confirmW === c.id && (
                <div className="alert alert-warning" style={{ marginTop: 8 }}>
                  <p style={{ margin: 0 }}>Möchten Sie Ihre Einwilligung widerrufen? Es entstehen Ihnen keine Nachteile. Weitere Befragungen werden sofort gestoppt; bereits versandte Links werden ungültig.</p>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn-danger" onClick={() => api(`/portal/consents/${c.id}/withdraw`, { body: { confirm: true } }).then(() => { setMsg('Ihr Widerruf wurde gespeichert. Sie werden nicht mehr kontaktiert.'); setConfirmW(null); return load(); }).catch(setError)}>Ja, widerrufen</button>
                    <button className="btn-ghost" onClick={() => setConfirmW(null)}>Abbrechen</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {copy && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            <strong>Kopie Ihrer Einwilligung</strong>
            {copy.nachweis?.informationstext && <div className="consent-text" style={{ marginTop: 8 }}>{copy.nachweis.informationstext}</div>}
            <p className="small" style={{ marginTop: 8 }}>Zugestimmter Umfang: {(copy.nachweis?.zugestimmter_umfang ?? copy.nachweis?.umfang ?? []).join(', ')} · Datum: {fmtDate(copy.nachweis?.unterschriftsdatum)} · Verfahren: {copy.nachweis?.signaturverfahren ?? copy.nachweis?.verfahren}</p>
            <p className="small muted" style={{ margin: 0 }}>{copy.nachweis?.hinweis}</p>
            <button className="btn-ghost btn-small" onClick={() => window.print()}>Drucken</button>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="h-bef">
        <h2 id="h-bef">Ihre Befragungen</h2>
        {valid.length === 0 && <p className="muted">Befragungen sind erst nach gültiger Einwilligung möglich.</p>}
        {me.surveys.map((s: any, i: number) => (
          <div key={i}>
            <h3>Behandlung: {s.caseLabel}</h3>
            {!s.consentOk && <Alert kind="warning">{s.consentReason ?? 'Befragung gesperrt'}</Alert>}
            <ol className="timeline">
              {s.events.map((e: any) => (
                <li key={e.eventId}>
                  <strong>{TP[e.timepoint] ?? e.timepoint}</strong>
                  <span className="small">{e.open ? `bis ${fmtDate(e.windowEnd)}` : `ab ${fmtDate(e.windowStart)}`}</span>
                  <span className="row">
                    <EventBadge status={e.status} />
                    {e.open && e.responseId && <Link className="btn btn-small" href={`/portal/befragung/${e.responseId}`}>{e.status === 'begonnen' ? 'Fortsetzen' : 'Starten'}</Link>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>
      <button className="btn-ghost" onClick={() => api('/portal/logout', { body: {} }).finally(() => { window.location.href = '/portal/einladung'; })}>Abmelden</button>
    </>
  );
}
