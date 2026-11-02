'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr, fileToBase64 } from '@/lib/api';
import { CASE_STATUS_LABEL, fmtDate, fmtDateTime, JOINT_LABEL, OUTBOX_STATUS_LABEL, RESPONSE_STATUS_LABEL } from '@/lib/format';
import { Onsite, takeOnsite } from '@/lib/onsite';
import { Alert, Badge, ConceptNote, ConsentBadge, ErrorBox, EventBadge, Loading } from '@/components/ui';

const TP: Record<string, string> = { BL: 'Baseline', M6: '6 Monate', M12: '12 Monate', M24: '24 Monate', M36: '36 Monate', M60: '60 Monate', M120: '120 Monate', FU3: 'FU3 (historisch)' };
const MOD: Record<string, string> = { BASIS: 'Basis', MENISKUS: 'Meniskus', KREUZBAND: 'VKB/HKB', PATELLA: 'Patella', KNORPEL: 'Knorpel', OSTEOTOMIE: 'Osteotomie', ENDOPROTHETIK: 'Endoprothetik', SYNOVITIS: 'Synovitis', PATELLASEHNE_KONS: 'Patellasehne kons.' };
const METHOD: Record<string, string> = { digital_demo: 'Digitale Demo-Signatur (keine QES)', papier_upload: 'Papierupload', altbestand: 'Altbestand' };
const REF: Record<string, string> = { op_tatsaechlich: 'tatsächliches OP-Datum', op_geplant: 'geplantes OP-Datum (vorläufig)', konservativ: 'Beginn konservative Behandlung' };

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [identity, setIdentity] = useState<any>(null);
  const [onsite, setOnsite] = useState<Onsite | null>(null);
  const [catalog, setCatalog] = useState<any>(null);
  const [docs, setDocs] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      setD(await api(`/cases/${id}`));
      setError(null);
    } catch (e) {
      setError(e as ApiErr);
    }
  }, [id]);
  useEffect(() => {
    void load();
    setOnsite(takeOnsite(id));
    api('/meta/catalog').then(setCatalog).catch(() => undefined);
    api('/meta/consent-documents').then((r) => setDocs(r.items)).catch(() => undefined);
  }, [load, id]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setError(e as ApiErr);
    }
  }

  if (error && !d) return <ErrorBox error={error} onRetry={load} />;
  if (!d) return <Loading what="Fall" />;
  const c = d.case;
  const open = d.consents.find((x: any) => ['vorbereitet', 'signatur_ausstehend', 'upload_in_pruefung', 'abgelehnt'].includes(x.status) && !d.consents.some((y: any) => y.status === 'gueltig' && y.created_at > x.created_at));
  const valid = d.consents.find((x: any) => x.status === 'gueltig');
  const physician = d.responses.filter((r: any) => r.audience === 'arzt');
  const patientForms = d.responses.filter((r: any) => r.audience === 'patient');
  const firstOpen = physician.find((r: any) => r.status !== 'abgeschlossen') ?? physician[0];

  return (
    <>
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: 4 }}>Fall {c.case_no}</h1>
          <p className="muted" style={{ margin: 0 }}>Pseudonym {d.patient.pseudonym} · {JOINT_LABEL[c.joint]} {c.side} · {c.treatment_type === 'operativ' ? 'operative' : 'konservative'} Behandlung</p>
        </div>
        <div className="row">
          <Badge tone={c.status === 'aktiv' ? 'ok' : c.status === 'consent_ausstehend' ? 'warn' : 'bad'}>{CASE_STATUS_LABEL[c.status]}</Badge>
          <ConsentBadge status={valid ? 'gueltig' : d.consents[0]?.status ?? null} />
          <Badge tone="info">{c.mode === 'science' ? 'DART Science' : 'DART Basic'}</Badge>
        </div>
      </div>
      <ConceptNote />
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {c.status === 'consent_ausstehend' && <Alert kind="warning" title="Erfassung gesperrt">Medizinische Registerdaten können erst nach gültiger Einwilligung im benötigten Umfang erfasst werden.</Alert>}

      <div className="grid grid-2">
        <section className="card" aria-labelledby="h-stamm">
          <h2 id="h-stamm">Behandlung</h2>
          <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0 }}>
            <dt>Register</dt><dd style={{ margin: 0 }}>{c.registers.join(', ')}</dd>
            <dt>Module</dt><dd style={{ margin: 0 }}>{c.modules.length ? c.modules.map((m: string) => MOD[m] ?? m).join(', ') : 'nur Basis'}</dd>
            <dt>Eingriffe</dt><dd style={{ margin: 0 }}>{d.procedures.length ? d.procedures.map((p: any) => `${p.ops_code} · ${p.concept_code} (${p.ops_version})`).join('; ') : '–'}</dd>
            <dt>Geplantes OP-Datum</dt><dd style={{ margin: 0 }}>{fmtDate(c.planned_op_date)}</dd>
            <dt>Tatsächliches OP-Datum</dt><dd style={{ margin: 0 }}>{fmtDate(c.actual_op_date)}</dd>
            <dt>Konservativer Beginn</dt><dd style={{ margin: 0 }}>{fmtDate(c.conservative_start_date)}</dd>
            <dt>Modushistorie</dt><dd style={{ margin: 0 }}>{d.modeHistory.map((m: any) => `${m.mode === 'science' ? 'Science' : 'Basic'} ab ${fmtDateTime(m.valid_from)}${m.valid_to ? ` bis ${fmtDateTime(m.valid_to)}` : ''}`).join('; ')}</dd>
          </dl>
          {d.canSeeIdentity && (
            <div style={{ marginTop: 12 }}>
              {identity ? (
                <p className="small" aria-live="polite"><strong>{identity.firstName} {identity.lastName}</strong>{identity.email ? ` · ${identity.email}` : ''}{identity.birthDate ? ` · geb. ${fmtDate(identity.birthDate)}` : ''} <span className="muted">(aus dem Identity Vault, Zugriff protokolliert)</span></p>
              ) : (
                <button className="btn-ghost btn-small" onClick={() => api(`/cases/${id}/identity`).then(setIdentity).catch(setError)}>Klarname anzeigen (protokolliert)</button>
              )}
            </div>
          )}
          <details style={{ marginTop: 12 }}>
            <summary>Datum korrigieren</summary>
            <DateCorrection c={c} onDone={(r: unknown) => act(async () => r, 'Datum korrigiert. Nur offene Termine wurden neu geplant.')} onError={setError} />
          </details>
          <details style={{ marginTop: 8 }}>
            <summary>Erfassungsmodus wechseln</summary>
            <ModeChange c={c} onDone={() => act(async () => undefined, 'Modus gewechselt (mit Gültigkeitsdatum historisiert).')} onError={setError} />
          </details>
          <p className="small" style={{ marginTop: 12 }}><Link href={`/faelle/neu?patient=${d.patient.id}`}>Weiteren Fall für diese Person anlegen</Link>{d.otherCases.length > 0 && <> · Weitere Fälle: {d.otherCases.map((o: any) => <Link key={o.id} href={`/faelle/${o.id}`} style={{ marginRight: 8 }}>{o.case_no} ({JOINT_LABEL[o.joint]} {o.side})</Link>)}</>}</p>
        </section>

        <section className="card" aria-labelledby="h-consent">
          <h2 id="h-consent">Einwilligung</h2>
          {d.consents.length === 0 && <p>Noch keine Einwilligung vorbereitet.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.consents.map((x: any) => (
              <li key={x.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                <ConsentBadge status={x.status} /> <span className="small">{METHOD[x.method]} · {x.document_title ?? 'Altbestand'} {x.document_version ?? ''}</span>
                <div className="small muted">Umfang: {x.scopes.map((s: string) => catalog?.consentScopes?.[s] ?? s).join('; ') || '–'}</div>
                <div className="small muted">Unterschriftsdatum {fmtDate(x.signed_date)} · Upload {fmtDateTime(x.uploaded_at)} · Prüfung {fmtDateTime(x.reviewed_at)}</div>
                {x.rejection_reason && <div className="small" style={{ color: 'var(--danger)' }}>Grund: {x.rejection_reason}</div>}
                {x.status === 'gueltig' && d.canManageConsent && <Withdraw consentId={x.id} onDone={() => act(async () => undefined, 'Widerruf erfasst. Befragungen und Versand sind gesperrt.')} onError={setError} />}
              </li>
            ))}
          </ul>
          {open?.status === 'signatur_ausstehend' && d.canManageConsent && (
            <div style={{ marginTop: 12 }}>
              {onsite ? (
                <div className="alert alert-info">
                  <strong>Persönliche Einladung vor Ort</strong>
                  <p className="small" style={{ margin: '4px 0' }}>Öffnen Sie den Link auf dem Gerät der Patientin/des Patienten. Der Zugangscode wird persönlich übergeben. Beides wird nur jetzt angezeigt und nicht gespeichert.</p>
                  <p style={{ margin: '4px 0', wordBreak: 'break-all' }}><a href={onsite.portalLink} target="_blank" rel="noreferrer">{onsite.portalLink}</a></p>
                  <p style={{ margin: 0 }}>Zugangscode: <strong style={{ fontSize: '1.4rem', letterSpacing: 2 }}>{onsite.accessCode}</strong> <span className="small muted">(gültig {onsite.expiresInMinutes} Minuten für die Einlösung)</span></p>
                </div>
              ) : (
                <button className="btn-secondary" onClick={() => api(`/consents/${open.id}/onsite-link`, { body: {} }).then(setOnsite).catch(setError)}>Vor-Ort-Zugang erzeugen</button>
              )}
            </div>
          )}
          {open && ['vorbereitet', 'abgelehnt'].includes(open.status) && open.method === 'papier_upload' && d.canManageConsent && <Upload consentId={open.id} onDone={() => act(async () => undefined, 'Nachweis hochgeladen – Prüfung ausstehend. Der Status ist noch nicht gültig.')} onError={setError} />}
          {open?.status === 'upload_in_pruefung' && <p className="small" style={{ marginTop: 8 }}>Nachweis wartet auf Sichtprüfung. {d.canReviewConsent && <Link href="/nachweise">Zur Prüfung</Link>}</p>}
          {!open && !valid && d.canManageConsent && <PrepareConsent patientId={d.patient.id} docs={docs} catalog={catalog} c={c} onDone={(r: any) => { if (r.onsite) setOnsite(r.onsite); void act(async () => undefined, 'Einwilligung vorbereitet.'); }} onError={setError} />}
        </section>
      </div>

      <section className="card" aria-labelledby="h-boegen">
        <h2 id="h-boegen">Bögen</h2>
        {physician.length === 0 && <p className="muted">Noch keine Bögen – sie werden nach gültiger Einwilligung gemäß Zuordnungsmatrix angelegt ({d.expectedForms.map((f: any) => f.questionnaire).join(', ')}).</p>}
        {physician.length > 0 && (
          <>
            <nav className="row" aria-label="Module">{physician.map((r: any) => <Link key={r.id} className="chip" href={`/faelle/${id}/boegen/${r.id}`}>{MOD[r.module_code] ?? r.module_code} · {RESPONSE_STATUS_LABEL[r.status]}</Link>)}</nav>
            {firstOpen && <p style={{ marginTop: 12 }}><Link className="btn" href={`/faelle/${id}/boegen/${firstOpen.id}`}>Arztbogen öffnen</Link></p>}
          </>
        )}
        {patientForms.length > 0 && (
          <>
            <h3>Patientenbefragungen</h3>
            <ul>{patientForms.map((r: any) => <li key={r.id}><Link href={`/faelle/${id}/boegen/${r.id}`}>{r.title}</Link> (V{r.version}) – {RESPONSE_STATUS_LABEL[r.status]} {r.submitted_at ? `am ${fmtDateTime(r.submitted_at)}` : ''}</li>)}</ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="h-zeit">
        <h2 id="h-zeit">Follow-up-Zeitachse</h2>
        {d.events.length === 0 ? <p className="muted">Zeitachse wird nach gültiger Einwilligung geplant.</p> : (
          <>
            <p className="small muted">Bezug: {REF[d.events[0].reference_kind] ?? d.events[0].reference_kind}. Plan FU-PLAN-KNIE V1 (Vorschlag, fachlich freizugeben).</p>
            <ol className="timeline">
              {d.events.map((e: any) => (
                <li key={e.id}>
                  <strong>{TP[e.timepoint] ?? e.timepoint}</strong>
                  <span className="small">Soll {fmtDate(e.due_date)} · Fenster {fmtDate(e.window_start)}–{fmtDate(e.window_end)}{e.completed_at ? ` · abgeschlossen ${fmtDateTime(e.completed_at)}` : ''}</span>
                  <EventBadge status={e.display_status} />
                </li>
              ))}
            </ol>
          </>
        )}
        {d.outbox.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary>Versandjournal ({d.outbox.length})</summary>
            <ul className="small">{d.outbox.map((o: any, i: number) => <li key={i}>{o.kind === 'arzt_erinnerung' ? 'Arzt-Erinnerung' : o.kind === 'erinnerung' ? `Erinnerung (${o.stage})` : 'Einladung'} · {fmtDateTime(o.scheduled_at)} · {OUTBOX_STATUS_LABEL[o.status] ?? o.status}{o.cancel_reason ? ` (${o.cancel_reason})` : ''}</li>)}</ul>
          </details>
        )}
      </section>
    </>
  );
}

function PrepareConsent({ patientId, docs, catalog, c, onDone, onError }: any) {
  const required = ['register_basic', ...(c.mode === 'science' ? ['science'] : []), ...(c.registers.includes('KNORPEL_DGOU') ? ['knorpelregister'] : []), ...(c.registers.includes('DEKOR') ? ['dekor'] : [])];
  const [scopes, setScopes] = useState<string[]>(required);
  const [method, setMethod] = useState('digital_demo');
  const doc = docs[0];
  if (!doc || !catalog) return null;
  return (
    <form style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); api('/consents', { body: { patientId, documentVersionId: doc.id, scopes, method } }).then(onDone).catch(onError); }}>
      <h3>Einwilligung vorbereiten</h3>
      <fieldset><legend>Angebotener Umfang (Zustimmung erfolgt aktiv durch die Person)</legend>
        {doc.scopes.map((s: string) => <label key={s} className="choice"><input type="checkbox" checked={scopes.includes(s)} disabled={s === 'register_basic'} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />{catalog.consentScopes[s]}{required.includes(s) ? ' (für diesen Fall erforderlich)' : ''}</label>)}
      </fieldset>
      <fieldset><legend>Weg</legend>
        <label className="choice"><input type="radio" name="m" checked={method === 'digital_demo'} onChange={() => setMethod('digital_demo')} />Digitale Signatur vor Ort (Demonstration)</label>
        <label className="choice"><input type="radio" name="m" checked={method === 'papier_upload'} onChange={() => setMethod('papier_upload')} />Upload eines unterschriebenen Dokuments</label>
      </fieldset>
      <button type="submit">Vorbereiten</button>
    </form>
  );
}

function Upload({ consentId, onDone, onError }: any) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form style={{ marginTop: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) return onError({ message: 'Die Datei ist größer als 20 MB.' });
      setBusy(true);
      try {
        await api(`/consents/${consentId}/evidence`, { body: { fileName: file.name, contentType: file.type, contentBase64: await fileToBase64(file) }, headers: { 'idempotency-key': `upload-${consentId}-${file.name}-${file.size}-${file.lastModified}` } });
        onDone();
      } catch (err) {
        onError(err);
      } finally {
        setBusy(false);
      }
    }}>
      <div className="field"><label htmlFor="up">Unterschriebene Erklärung hochladen (PDF, JPEG oder PNG, höchstens 20 MB)</label><input id="up" type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><div className="help">Der Upload wird auf Dateityp und Schadsoftware geprüft und danach von berechtigtem Personal gesichtet. Erst dann ist die Einwilligung gültig.</div></div>
      <button type="submit" disabled={!file || busy}>{busy ? 'Wird geprüft …' : 'Hochladen'}</button>
    </form>
  );
}

function Withdraw({ consentId, onDone, onError }: any) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState('personal');
  if (!open) return <button className="btn-ghost btn-small" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>Widerruf erfassen</button>;
  return (
    <div className="alert alert-warning" style={{ marginTop: 8 }}>
      <p className="small" style={{ margin: 0 }}>Der Widerruf sperrt sofort weitere Befragungen und Versand. Bereits versandte E-Mails werden wirkungslos. Der Umgang mit vorhandenen Daten folgt dem freigegebenen Rechtskonzept.</p>
      <div className="row" style={{ marginTop: 8 }}>
        <label htmlFor={`ch-${consentId}`} className="sr-only">Kanal</label>
        <select id={`ch-${consentId}`} value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: 'auto' }}><option value="personal">persönlich</option><option value="schriftlich">schriftlich</option></select>
        <button className="btn-danger btn-small" onClick={() => api(`/consents/${consentId}/withdraw`, { body: { channel } }).then(onDone).catch(onError)}>Widerruf bestätigen</button>
        <button className="btn-ghost btn-small" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
    </div>
  );
}

function DateCorrection({ c, onDone, onError }: any) {
  const [v, setV] = useState({ plannedOpDate: c.planned_op_date ?? '', actualOpDate: c.actual_op_date ?? '', conservativeStartDate: c.conservative_start_date ?? '', reason: '' });
  return (
    <form className="grid" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); api(`/cases/${c.id}/dates`, { body: { plannedOpDate: v.plannedOpDate || null, actualOpDate: v.actualOpDate || null, conservativeStartDate: v.conservativeStartDate || null, reason: v.reason, revision: c.revision } }).then(onDone).catch(onError); }}>
      {c.treatment_type === 'operativ' ? (
        <>
          <div className="field"><label htmlFor="dc1">Geplantes OP-Datum</label><input id="dc1" type="date" value={v.plannedOpDate} onChange={(e) => setV({ ...v, plannedOpDate: e.target.value })} /></div>
          <div className="field"><label htmlFor="dc2">Tatsächliches OP-Datum</label><input id="dc2" type="date" value={v.actualOpDate} onChange={(e) => setV({ ...v, actualOpDate: e.target.value })} /></div>
        </>
      ) : <div className="field"><label htmlFor="dc3">Behandlungsbeginn</label><input id="dc3" type="date" value={v.conservativeStartDate} onChange={(e) => setV({ ...v, conservativeStartDate: e.target.value })} /></div>}
      <div className="field"><label htmlFor="dc4">Begründung (Pflicht)</label><input id="dc4" type="text" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></div>
      <button type="submit" className="btn-secondary" disabled={v.reason.trim().length < 5}>Korrektur speichern</button>
    </form>
  );
}

function ModeChange({ c, onDone, onError }: any) {
  const [reason, setReason] = useState('');
  const target = c.mode === 'science' ? 'basic' : 'science';
  return (
    <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); api(`/cases/${c.id}/mode`, { body: { mode: target, reason } }).then(onDone).catch(onError); }}>
      <label htmlFor="mc" className="sr-only">Begründung</label>
      <input id="mc" type="text" placeholder="Begründung" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 320 }} />
      <button type="submit" className="btn-secondary btn-small" disabled={reason.trim().length < 5}>Wechsel zu {target === 'science' ? 'DART Science' : 'DART Basic'}</button>
      <span className="small muted">Bestehende Basic-Daten werden nicht rückwirkend zu Science.</span>
    </form>
  );
}
