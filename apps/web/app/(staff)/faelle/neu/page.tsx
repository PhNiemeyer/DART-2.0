'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiErr } from '@/lib/api';
import { useMe } from '@/lib/session';
import { stashOnsite } from '@/lib/onsite';
import { Alert, ConceptNote, ErrorBox } from '@/components/ui';

interface Ops { code: string; version: string; concept: string; label: string; module?: string }
interface Catalog { modules: Array<{ code: string; label: string; suggestsRegister?: string }>; consentScopes: Record<string, string> }
interface Doc { id: string; title: string; version: string; scopes: string[] }

function Wizard() {
  const me = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const existingPatient = sp.get('patient');
  const writeCenters = me.centers.filter((c) => me.roles.some((r) => r.centerId === c.id && ['arzt', 'dokumentation', 'zentrumsverantwortlich'].includes(r.role)));
  const [step, setStep] = useState(1);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [staff, setStaff] = useState<{ surgeons: Array<{ id: string; display_name: string }>; scienceApproved: boolean } | null>(null);
  const [opsQ, setOpsQ] = useState('');
  const [opsHits, setOpsHits] = useState<Ops[]>([]);
  const [error, setError] = useState<ApiErr | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    centerId: writeCenters[0]?.id ?? '',
    firstName: '', lastName: '', email: '', birthDate: '',
    consentMethod: 'digital_demo' as 'digital_demo' | 'papier_upload',
    documentVersionId: '',
    scopes: [] as string[],
    joint: 'knie', side: '', treatmentType: '' as '' | 'operativ' | 'konservativ',
    modules: [] as string[], procedures: [] as Ops[],
    surgeonUserId: '', plannedOpDate: '', actualOpDate: '', conservativeStartDate: '',
    mode: 'basic' as 'basic' | 'science', registers: ['DART'] as string[],
  });
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));

  useEffect(() => {
    api('/meta/catalog').then(setCatalog).catch(setError);
    api('/meta/consent-documents').then((d) => { setDocs(d.items); if (d.items[0]) setV((x) => ({ ...x, documentVersionId: d.items[0].id })); }).catch(setError);
  }, []);
  useEffect(() => {
    if (v.centerId) api(`/meta/centers/${v.centerId}/staff`).then(setStaff).catch(setError);
  }, [v.centerId]);
  useEffect(() => {
    const t = setTimeout(() => api(`/meta/ops?q=${encodeURIComponent(opsQ)}`).then((r) => setOpsHits(r.items)).catch(() => undefined), 200);
    return () => clearTimeout(t);
  }, [opsQ]);

  const scopesNeeded = ['register_basic', ...(v.mode === 'science' ? ['science'] : []), ...(v.registers.includes('KNORPEL_DGOU') ? ['knorpelregister'] : []), ...(v.registers.includes('DEKOR') ? ['dekor'] : [])];
  const errs1: string[] = [];
  if (!existingPatient) {
    if (!v.firstName.trim()) errs1.push('Vorname fehlt');
    if (!v.lastName.trim()) errs1.push('Nachname fehlt');
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errs1.push('E-Mail-Adresse ist ungültig');
  }
  if (!v.centerId) errs1.push('Zentrum fehlt');
  const errs2: string[] = [];
  if (!v.side) errs2.push('Seite fehlt');
  if (!v.treatmentType) errs2.push('Behandlungsart fehlt');
  const errs3: string[] = [];
  if (v.treatmentType === 'operativ' && !v.plannedOpDate && !v.actualOpDate) errs3.push('Geplantes oder tatsächliches OP-Datum fehlt');
  if (v.treatmentType === 'konservativ' && !v.conservativeStartDate) errs3.push('Behandlungsbeginn fehlt');
  if (v.mode === 'science' && staff && !staff.scienceApproved) errs3.push('DART Science ist für dieses Zentrum nicht freigegeben');
  const [showErr, setShowErr] = useState(false);

  function next(errs: string[]) {
    if (errs.length) {
      setShowErr(true);
      return;
    }
    setShowErr(false);
    setStep((s) => s + 1);
    setTimeout(() => document.getElementById('step-title')?.focus(), 0);
  }

  function toggleOps(o: Ops) {
    const has = v.procedures.some((p) => p.code === o.code && p.concept === o.concept);
    const procedures = has ? v.procedures.filter((p) => !(p.code === o.code && p.concept === o.concept)) : [...v.procedures, o];
    const modules = new Set(v.modules);
    if (!has && o.module) modules.add(o.module);
    const registers = new Set(v.registers);
    const mod = catalog?.modules.find((m) => m.code === o.module);
    if (!has && mod?.suggestsRegister) registers.add(mod.suggestsRegister);
    set({ procedures, modules: [...modules], registers: [...registers] });
  }

  async function create() {
    if (errs3.length) {
      setShowErr(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        patient: existingPatient ? { existingPatientId: existingPatient } : { firstName: v.firstName, lastName: v.lastName, email: v.email || undefined, birthDate: v.birthDate || undefined },
        centerId: v.centerId, joint: v.joint, side: v.side, treatmentType: v.treatmentType,
        surgeonUserId: v.surgeonUserId || null,
        plannedOpDate: v.treatmentType === 'operativ' ? v.plannedOpDate || null : null,
        actualOpDate: v.treatmentType === 'operativ' ? v.actualOpDate || null : null,
        conservativeStartDate: v.treatmentType === 'konservativ' ? v.conservativeStartDate : null,
        mode: v.mode, registers: v.registers, modules: v.modules,
        procedures: v.procedures.map((p) => ({ code: p.code, version: p.version, concept: p.concept })),
      };
      const created = await api('/cases', { body, headers: { 'idempotency-key': `neu-${idemKey}` } });
      let consentInfo: any = null;
      if (!created.activated && !existingPatient) {
        const scopes = [...new Set([...scopesNeeded, ...v.scopes])];
        consentInfo = await api('/consents', { body: { patientId: created.patientId, documentVersionId: v.documentVersionId, scopes, method: v.consentMethod, informedBy: me.displayName } });
      }
      if (consentInfo?.onsite) stashOnsite(created.id, consentInfo.onsite);
      router.push(`/faelle/${created.id}`);
    } catch (e) {
      setError(e as ApiErr);
    } finally {
      setBusy(false);
    }
  }
  const [idemKey] = useState(() => crypto.randomUUID());

  const errsNow = step === 1 ? errs1 : step === 2 ? errs2 : errs3;
  const labels = ['Patient / Einwilligung', 'Gelenk / Behandlung', 'Datum / Register / Modus'];

  return (
    <>
      <h1>Neuen Behandlungsfall anlegen</h1>
      <ConceptNote />
      <ol className="steps" aria-label="Schritte">
        {labels.map((l, i) => <li key={l} aria-current={step === i + 1 ? 'step' : undefined} className={step > i + 1 ? 'done' : undefined}>{i + 1} {l}{step > i + 1 ? ' ✓' : ''}</li>)}
      </ol>
      <ErrorBox error={error} />
      {showErr && errsNow.length > 0 && (
        <Alert kind="error" title="Bitte prüfen Sie Ihre Eingaben">
          <ul>{errsNow.map((e) => <li key={e}>{e}</li>)}</ul>
        </Alert>
      )}

      {step === 1 && (
        <section className="card" aria-labelledby="step-title">
          <h2 id="step-title" tabIndex={-1}>1 Patient und Einwilligung</h2>
          {writeCenters.length > 1 && (
            <div className="field"><label htmlFor="center">Zentrum</label><select id="center" value={v.centerId} onChange={(e) => set({ centerId: e.target.value })}>{writeCenters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          )}
          {existingPatient ? (
            <Alert kind="info">Weiterer Fall für eine bereits erfasste Person. Identität und Einwilligung werden übernommen und erneut geprüft.</Alert>
          ) : (
            <>
              <p className="small muted">Name und Kontakt werden ausschließlich im getrennten Identity Vault gespeichert. Bitte nur synthetische Testdaten verwenden.</p>
              <div className="grid grid-2">
                <div className="field"><label htmlFor="fn">Vorname</label><input id="fn" type="text" autoComplete="off" value={v.firstName} aria-invalid={showErr && !v.firstName.trim()} onChange={(e) => set({ firstName: e.target.value })} /></div>
                <div className="field"><label htmlFor="ln">Nachname</label><input id="ln" type="text" autoComplete="off" value={v.lastName} aria-invalid={showErr && !v.lastName.trim()} onChange={(e) => set({ lastName: e.target.value })} /></div>
                <div className="field"><label htmlFor="em">E-Mail für Verlaufsbefragungen (optional)</label><input id="em" type="email" autoComplete="off" value={v.email} onChange={(e) => set({ email: e.target.value })} /><div className="help">Nur mit Einwilligung zur Kontaktaufnahme.</div></div>
                <div className="field"><label htmlFor="bd">Geburtsdatum (optional)</label><input id="bd" type="date" value={v.birthDate} onChange={(e) => set({ birthDate: e.target.value })} /><div className="help">Nur erfassen, wenn fachlich erforderlich und freigegeben (offene Entscheidung).</div></div>
              </div>
              <fieldset>
                <legend>Weg der Einwilligung</legend>
                <label className="choice"><input type="radio" name="cm" checked={v.consentMethod === 'digital_demo'} onChange={() => set({ consentMethod: 'digital_demo' })} />Persönliche digitale Signatur vor Ort (Demonstration, keine QES)</label>
                <label className="choice"><input type="radio" name="cm" checked={v.consentMethod === 'papier_upload'} onChange={() => set({ consentMethod: 'papier_upload' })} />Upload einer handschriftlich unterschriebenen Erklärung</label>
                {docs.length > 0 && <p className="small muted" style={{ margin: 0 }}>Dokument: {docs[0].title}, Version {docs[0].version}</p>}
              </fieldset>
              <fieldset>
                <legend>Zusätzlicher Umfang (optional)</legend>
                <label className="choice"><input type="checkbox" checked={v.scopes.includes('kontakt_followup')} onChange={(e) => set({ scopes: e.target.checked ? [...v.scopes, 'kontakt_followup'] : v.scopes.filter((s) => s !== 'kontakt_followup') })} />{catalog?.consentScopes.kontakt_followup ?? 'Kontaktaufnahme für Verlaufsbefragungen'}</label>
                <p className="small muted" style={{ margin: 0 }}>Nichts ist vorausgewählt. Der für Register und Modus nötige Umfang wird im 3. Schritt ergänzt und der Person zur aktiven Zustimmung vorgelegt.</p>
              </fieldset>
            </>
          )}
          <Alert kind="info">Medizinische Registerdaten können erst nach einer gültigen Einwilligung im benötigten Umfang erfasst werden.</Alert>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button onClick={() => next(errs1)}>Weiter</button></div>
        </section>
      )}

      {step === 2 && (
        <section className="card" aria-labelledby="step-title">
          <h2 id="step-title" tabIndex={-1}>2 Gelenk und Behandlung</h2>
          <div className="grid grid-3">
            <div className="field"><label htmlFor="joint">Gelenk</label><select id="joint" value={v.joint} onChange={(e) => set({ joint: e.target.value })}><option value="knie">Knie</option><option value="schulter" disabled>Schulter (vorbereitet)</option><option value="huefte" disabled>Hüfte (vorbereitet)</option><option value="sprunggelenk" disabled>Sprunggelenk (vorbereitet)</option></select></div>
            <fieldset><legend>Seite</legend><div className="choice-row">{['links', 'rechts'].map((s) => <label key={s} className="choice"><input type="radio" name="side" checked={v.side === s} onChange={() => set({ side: s })} />{s === 'links' ? 'Links' : 'Rechts'}</label>)}</div></fieldset>
            <fieldset><legend>Behandlung</legend><div className="choice-row"><label className="choice"><input type="radio" name="tt" checked={v.treatmentType === 'operativ'} onChange={() => set({ treatmentType: 'operativ' })} />Operativ</label><label className="choice"><input type="radio" name="tt" checked={v.treatmentType === 'konservativ'} onChange={() => set({ treatmentType: 'konservativ' })} />Konservativ</label></div></fieldset>
          </div>
          <div className="field">
            <label htmlFor="ops">Eingriffe suchen (OPS-Beispielkatalog, Mehrfachauswahl)</label>
            <input id="ops" type="search" value={opsQ} onChange={(e) => setOpsQ(e.target.value)} placeholder="Code oder Bezeichnung, z. B. 5-812 oder Knorpel" aria-describedby="ops-help" />
            <div id="ops-help" className="help">Beispielkatalog – vor dem Pilot gegen die amtliche OPS-Version zu prüfen. Gleiche Codes können verschiedene Eingriffskonzepte bezeichnen; das Konzept wird mitgespeichert.</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 4 }}>
              {opsHits.map((o) => {
                const on = v.procedures.some((p) => p.code === o.code && p.concept === o.concept);
                return <li key={o.code + o.concept}><label className="choice"><input type="checkbox" checked={on} onChange={() => toggleOps(o)} /><span><strong>{o.code}</strong> {o.label} <span className="small muted">({o.version})</span></span></label></li>;
              })}
            </ul>
          </div>
          <fieldset>
            <legend>Zusatzmodule (mehrere auswählbar)</legend>
            <div className="grid grid-3">
              {catalog?.modules.map((m) => (
                <label key={m.code} className="choice"><input type="checkbox" checked={v.modules.includes(m.code)} onChange={(e) => set({ modules: e.target.checked ? [...v.modules, m.code] : v.modules.filter((x) => x !== m.code) })} />{m.label}</label>
              ))}
            </div>
            <p className="small muted" style={{ margin: 0 }}>Die Basis entsprechend dem Modus erhält jeder Kniefall; Module ergänzen sie. Bogenzuordnung gemäß Zuordnungsmatrix V1 (Vorschlag).</p>
          </fieldset>
          <div className="row between"><button className="btn-ghost" onClick={() => setStep(1)}>Zurück</button><button onClick={() => next(errs2)}>Weiter</button></div>
        </section>
      )}

      {step === 3 && (
        <section className="card" aria-labelledby="step-title">
          <h2 id="step-title" tabIndex={-1}>3 Datum, Register und Modus</h2>
          <div className="grid grid-3">
            {v.treatmentType === 'operativ' ? (
              <>
                <div className="field"><label htmlFor="pod">Geplantes OP-Datum</label><input id="pod" type="date" value={v.plannedOpDate} onChange={(e) => set({ plannedOpDate: e.target.value })} /></div>
                <div className="field"><label htmlFor="aod">Tatsächliches OP-Datum (falls erfolgt)</label><input id="aod" type="date" value={v.actualOpDate} onChange={(e) => set({ actualOpDate: e.target.value })} /></div>
                <div className="field"><label htmlFor="sur">Operateur/in</label><select id="sur" value={v.surgeonUserId} onChange={(e) => set({ surgeonUserId: e.target.value })}><option value="">– nicht festgelegt –</option>{staff?.surgeons.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}</select></div>
              </>
            ) : (
              <div className="field"><label htmlFor="csd">Beginn der konservativen Behandlung</label><input id="csd" type="date" value={v.conservativeStartDate} onChange={(e) => set({ conservativeStartDate: e.target.value })} /><div className="help">Eigenes Bezugsdatum – kein fiktives OP-Datum.</div></div>
            )}
          </div>
          <fieldset>
            <legend>Erfassungsmodus</legend>
            <div className="choice-row">
              <label className="choice"><input type="radio" name="mode" checked={v.mode === 'basic'} onChange={() => set({ mode: 'basic' })} />DART Basic</label>
              <label className="choice"><input type="radio" name="mode" checked={v.mode === 'science'} disabled={staff ? !staff.scienceApproved : true} onChange={() => set({ mode: 'science' })} />DART Science{staff && !staff.scienceApproved ? ' (für dieses Zentrum nicht freigegeben)' : ''}</label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Register</legend>
            <label className="choice"><input type="checkbox" checked disabled />DART (erforderlich)</label>
            {['KNORPEL_DGOU', 'DEKOR'].map((r) => (
              <label key={r} className="choice"><input type="checkbox" checked={v.registers.includes(r)} onChange={(e) => set({ registers: e.target.checked ? [...v.registers, r] : v.registers.filter((x) => x !== r) })} />{r === 'KNORPEL_DGOU' ? 'KnorpelRegister DGOU' : 'DEKOR'}</label>
            ))}
          </fieldset>
          <div className="alert alert-info">
            <strong>Zusammenfassung</strong>
            <ul>
              <li>{existingPatient ? 'Bestehende Person' : `${v.firstName} ${v.lastName}`} · Knie {v.side} · {v.treatmentType === 'operativ' ? 'operativ' : 'konservativ'}</li>
              <li>Modus: {v.mode === 'science' ? 'DART Science' : 'DART Basic'} · Register: {v.registers.join(', ')}</li>
              <li>Module: {v.modules.length ? v.modules.join(', ') : 'nur Basis'} · Eingriffe: {v.procedures.length ? v.procedures.map((p) => `${p.code} (${p.concept})`).join(', ') : 'keine'}</li>
              {!existingPatient && <li>Einwilligung: {v.consentMethod === 'digital_demo' ? 'digitale Demo-Signatur vor Ort' : 'Papierupload mit Sichtprüfung'} · Umfang: {[...new Set([...scopesNeeded, ...v.scopes])].map((s) => catalog?.consentScopes[s] ?? s).join('; ')}</li>}
            </ul>
          </div>
          <div className="row between"><button className="btn-ghost" onClick={() => setStep(2)}>Zurück</button><button onClick={create} disabled={busy}>{busy ? 'Wird angelegt …' : 'Fall anlegen'}</button></div>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><Wizard /></Suspense>;
}
