'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';
import { DateInput } from '@/components/DateInput';

const TP: Record<string, string> = { BL: 'Baseline', M6: '6 Monate', M12: '12 Monate', M24: '24 Monate', M36: '36 Monate', M60: '60 Monate', M120: '120 Monate' };
const ST: Record<string, string> = { beantragt: 'beantragt', genehmigt: 'genehmigt', abgelehnt: 'abgelehnt', in_arbeit: 'in Arbeit', fertig: 'fertig', fehler: 'Fehler' };

export default function Reports() {
  const me = useMe();
  const [rep, setRep] = useState<any>(null);
  const [exports, setExports] = useState<any[] | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ centerId: '', from: '', to: '' });
  const [req, setReq] = useState({ purpose: '', scope: 'basic', periodFrom: '2026-01-01', periodTo: '2026-12-31', layers: ['normalisiert', 'scores'] });
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      if (can(me, 'report.read')) {
        const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
        setRep(await api(`/reports/center?${qs}`));
      }
      if (can(me, 'export.request') || can(me, 'export.approve')) setExports((await api('/exports')).items);
      setError(null);
    } catch (e) {
      setError(e as ApiErr);
    }
  }, [f, me]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <h1>Auswertung und Export</h1>
      <ConceptNote />
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {can(me, 'report.read') && (
        <section className="card" aria-labelledby="h-rep">
          <h2 id="h-rep">Zentrumsbericht</h2>
          <form className="grid grid-3" onSubmit={(e) => e.preventDefault()}>
            {me.centers.length > 1 && <div className="field"><label htmlFor="rc">Zentrum</label><select id="rc" value={f.centerId} onChange={(e) => setF({ ...f, centerId: e.target.value })}><option value="">Alle eigenen</option>{me.centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
            <div className="field"><label htmlFor="rf">Bezugsdatum von</label><DateInput id="rf" value={f.from} onChange={(iso) => setF({ ...f, from: iso })} /></div>
            <div className="field"><label htmlFor="rt">bis</label><DateInput id="rt" value={f.to} onChange={(iso) => setF({ ...f, to: iso })} /></div>
          </form>
          {!rep ? <Loading what="Bericht" /> : (
            <>
              <p className="small muted">Stichtag {fmtDate(rep.stichtag)} · Filter: {rep.filter.zentren} Zentrum/Zentren, {rep.filter.von ? fmtDate(rep.filter.von) : 'ohne Beginn'} bis {rep.filter.bis ? fmtDate(rep.filter.bis) : 'ohne Ende'} · Bezug: {rep.filter.bezug}</p>
              <div className="grid grid-3">
                <div className="kpi"><div className="num">{rep.totals.patients}</div>Patientinnen/Patienten</div>
                <div className="kpi"><div className="num">{rep.totals.cases}</div>Fälle (registerübergreifend einmal gezählt)</div>
                <div className="kpi"><div className="num">{rep.physicianCompleteness.total ? Math.round((rep.physicianCompleteness.done / rep.physicianCompleteness.total) * 100) : 0} %</div>Arztbögen abgeschlossen ({rep.physicianCompleteness.done} von {rep.physicianCompleteness.total}; Nenner: {rep.physicianCompleteness.nenner})</div>
              </div>
              <h3 style={{ marginTop: 16 }}>Modus und Register</h3>
              <p className="small">{rep.byMode.map((m: any) => `${m.mode === 'science' ? 'Science' : 'Basic'}: ${m.n}`).join(' · ')} · {rep.byRegister.map((r: any) => `${r.register_code}: ${r.n}`).join(' · ')} · Fälle mit mehreren Registern: {rep.multiRegisterCases}</p>
              <h3>Follow-up-Rücklauf</h3>
              <div className="table-wrap">
                <table className="data cards">
                  <thead><tr><th>Zeitpunkt</th><th>Fällig und zulässig (Nenner)</th><th>Abgeschlossen</th><th>Rücklauf</th><th>Gesperrt</th><th>Noch nicht fällig</th></tr></thead>
                  <tbody>{rep.followUp.map((x: any) => <tr key={x.timepoint}><td data-label="Zeitpunkt">{TP[x.timepoint] ?? x.timepoint}</td><td data-label="Nenner">{x.faellig}</td><td data-label="Abgeschlossen">{x.abgeschlossen}</td><td data-label="Rücklauf">{x.ruecklauf === null ? '–' : `${x.ruecklauf.toLocaleString('de-DE')} %`}</td><td data-label="Gesperrt">{x.gesperrt}</td><td data-label="Noch nicht fällig">{x.noch_nicht_faellig}</td></tr>)}</tbody>
                </table>
              </div>
              <ul className="small muted">{rep.hinweise.map((h: string) => <li key={h}>{h}</li>)}</ul>
            </>
          )}
        </section>
      )}
      {can(me, 'export.request') && (
        <section className="card" aria-labelledby="h-exp">
          <h2 id="h-exp">Forschungsexport beantragen</h2>
          <p className="small muted">Zweckgebunden, pseudonym, mit Datenwörterbuch und Prüfsummen. Genehmigung durch eine andere Person erforderlich. Basic-Daten werden nicht automatisch für Science freigegeben.</p>
          <form className="grid grid-2" onSubmit={(e) => { e.preventDefault(); api('/exports', { body: req }).then(() => { setMsg('Export beantragt.'); return load(); }).catch(setError); }}>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ep">Zweck</label><textarea id="ep" value={req.purpose} onChange={(e) => setReq({ ...req, purpose: e.target.value })} /></div>
            <div className="field"><label htmlFor="es">Umfang</label><select id="es" value={req.scope} onChange={(e) => setReq({ ...req, scope: e.target.value })}><option value="basic">Basic (Registerumfang)</option><option value="science">Science (nur Science-Fälle mit Science-Einwilligung)</option></select></div>
            <fieldset><legend>Ebenen</legend>{['normalisiert', 'scores'].map((l) => <label key={l} className="choice"><input type="checkbox" checked={req.layers.includes(l)} onChange={(e) => setReq({ ...req, layers: e.target.checked ? [...req.layers, l] : req.layers.filter((x) => x !== l) })} />{l === 'normalisiert' ? 'Normalisierte Antworten' : 'Abgeleitete Scores'}</label>)}</fieldset>
            <div className="field"><label htmlFor="ef">Zeitraum von</label><DateInput id="ef" value={req.periodFrom} onChange={(iso) => setReq({ ...req, periodFrom: iso })} /></div>
            <div className="field"><label htmlFor="et">bis</label><DateInput id="et" value={req.periodTo} onChange={(iso) => setReq({ ...req, periodTo: iso })} /></div>
            <div><button type="submit" disabled={req.purpose.trim().length < 10 || req.layers.length === 0}>Beantragen</button></div>
          </form>
        </section>
      )}
      {exports && (
        <section className="card" aria-labelledby="h-el">
          <h2 id="h-el">Exportaufträge</h2>
          {exports.length === 0 && <p className="muted">Keine Aufträge.</p>}
          {exports.map((x) => (
            <div key={x.id} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
              <div className="row between"><strong>{x.purpose}</strong><Badge tone={x.status === 'fertig' ? 'ok' : x.status === 'abgelehnt' || x.status === 'fehler' ? 'bad' : 'info'}>{ST[x.status]}</Badge></div>
              <p className="small muted" style={{ margin: 0 }}>{x.scope} · {fmtDate(x.period_from)}–{fmtDate(x.period_to)} · beantragt von {x.requested_by_name} am {fmtDateTime(x.created_at)}{x.decided_by_name ? ` · entschieden von ${x.decided_by_name}: ${x.decision_note}` : ''}</p>
              {x.result_summary && <p className="small" style={{ margin: 0 }}>Ergebnis: {x.result_summary.faelle ?? 0} Fälle{x.result_summary.kleingruppen?.length ? ` · Kleingruppen: ${x.result_summary.kleingruppen.join(', ')}` : ''}{x.result_summary.fehler ? ` · Fehler: ${x.result_summary.fehler}` : ''}</p>}
              {x.status === 'beantragt' && can(me, 'export.approve') && !x.own && (
                <div className="row" style={{ marginTop: 6 }}>
                  <label htmlFor={`n-${x.id}`} className="sr-only">Begründung</label>
                  <input id={`n-${x.id}`} type="text" placeholder="Begründung der Entscheidung" style={{ maxWidth: 320 }} value={notes[x.id] ?? ''} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} />
                  <button className="btn-small" disabled={(notes[x.id] ?? '').length < 5} onClick={() => api(`/exports/${x.id}/decide`, { body: { decision: 'genehmigt', note: notes[x.id] } }).then(load).catch(setError)}>Genehmigen</button>
                  <button className="btn-danger btn-small" disabled={(notes[x.id] ?? '').length < 5} onClick={() => api(`/exports/${x.id}/decide`, { body: { decision: 'abgelehnt', note: notes[x.id] } }).then(load).catch(setError)}>Ablehnen</button>
                </div>
              )}
              {x.status === 'fertig' && x.own && x.files && <p className="small" style={{ margin: '6px 0 0' }}>Dateien: {x.files.map((f: any) => <a key={f.name} href={`/api/v1/exports/${x.id}/files/${f.name}`} style={{ marginRight: 12 }}>{f.name}</a>)}</p>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
