'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { CASE_STATUS_LABEL, fmtDate, JOINT_LABEL } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { Alert, Badge, ConceptNote, ConsentBadge, ErrorBox, Loading } from '@/components/ui';
import { DateInput } from '@/components/DateInput';

interface Tasks { stichtag: string; patients: number; cases: number; consentMissing: number; evidenceToReview: number; physicianFormsOpen: number; followUpsDue: number; overdue: number }
interface CaseItem { id: string; case_no: string; center_name: string; pseudonym: string; joint: string; side: string; treatment_type: string; planned_op_date: string | null; actual_op_date: string | null; conservative_start_date: string | null; status: string; mode: string; registers: string[]; modules: string[]; open_physician_forms: number; consent_status: string | null; surgeon_name: string | null }

const MODULE_LABEL: Record<string, string> = { MENISKUS: 'Meniskus', KREUZBAND: 'VKB/HKB', PATELLA: 'Patella', KNORPEL: 'Knorpel', OSTEOTOMIE: 'Osteotomie', ENDOPROTHETIK: 'Endoprothetik', SYNOVITIS: 'Synovitis', PATELLASEHNE_KONS: 'Patellasehne kons.' };
const REG_LABEL: Record<string, string> = { DART: 'DART', KNORPEL_DGOU: 'KnorpelRegister', DEKOR: 'DEKOR' };

export default function Dashboard() {
  const me = useMe();
  const [tasks, setTasks] = useState<Tasks | null>(null);
  const [list, setList] = useState<{ items: CaseItem[]; totalCases: number; totalPatients: number; page: number; pageSize: number } | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ q: '', centerId: '', surgeonId: '', register: '', mode: '', status: '', module: '', from: '', to: '', page: 1 });
  const [surgeons, setSurgeons] = useState<Array<{ id: string; display_name: string }>>([]);
  useEffect(() => {
    Promise.all(me.centers.map((c) => api(`/meta/centers/${c.id}/staff`).then((r) => r.surgeons).catch(() => [])))
      .then((lists) => setSurgeons(lists.flat().filter((s: { id: string }, i: number, a: Array<{ id: string }>) => a.findIndex((x) => x.id === s.id) === i)));
  }, [me.centers]);
  const [nameQ, setNameQ] = useState('');
  const [nameHits, setNameHits] = useState<Array<{ case_id: string; case_no: string; pseudonym: string; joint: string; side: string }> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, String(v)]));
      const [t, l] = await Promise.all([api<Tasks>('/dashboard/tasks'), api(`/cases?${qs}`)]);
      setTasks(t);
      setList(l);
      setError(null);
    } catch (e) {
      setError(e as ApiErr);
    } finally {
      setLoading(false);
    }
  }, [f]);

  useEffect(() => {
    if (can(me, 'case.read')) void load();
    else setLoading(false);
  }, [load, me]);

  if (!can(me, 'case.read')) {
    return (
      <>
        <h1>Übersicht</h1>
        <Alert kind="info" title="Keine fachliche Fallansicht">Ihre Rolle hat keinen Zugriff auf Patientenfälle. Nutzen Sie die Navigation für Ihre Aufgaben.</Alert>
      </>
    );
  }

  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, page: 1, ...patch }));
  const pages = list ? Math.max(1, Math.ceil(list.totalCases / list.pageSize)) : 1;

  async function searchName(e: React.FormEvent) {
    e.preventDefault();
    try {
      setNameHits((await api('/patients/search-by-name', { body: { lastName: nameQ } })).items);
    } catch (err) {
      setError(err as ApiErr);
    }
  }

  return (
    <>
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>Patienten und Aufgaben</h1>
        {can(me, 'case.write') && <Link className="btn" href="/faelle/neu">Neuen Behandlungsfall anlegen</Link>}
      </div>
      <ConceptNote />
      <ErrorBox error={error} onRetry={load} />
      {tasks && (
        <section aria-label="Kennzahlen" className="grid grid-3" style={{ marginBottom: 16 }}>
          <button className="kpi" style={{ textAlign: 'left', fontWeight: 400 }} onClick={() => set({ status: 'arztbogen_offen' })}><div className="num">{tasks.physicianFormsOpen}</div>Arztbögen offen</button>
          <Link className="kpi" href="/nachweise"><div className="num">{tasks.evidenceToReview}</div>Nachweise prüfen</Link>
          <button className="kpi" style={{ textAlign: 'left', fontWeight: 400 }} onClick={() => set({ status: 'consent_ausstehend' })}><div className="num">{tasks.consentMissing}</div>Fälle ohne gültige Einwilligung</button>
          <div className="kpi"><div className="num">{tasks.followUpsDue}</div>Follow-ups im Fenster</div>
          <button className="kpi" style={{ textAlign: 'left', fontWeight: 400 }} onClick={() => set({ status: 'ueberfaellig' })}><div className="num">{tasks.overdue}</div>Überfällige Befragungen</button>
          <div className="kpi"><div className="num">{tasks.patients} / {tasks.cases}</div>Patienten / Fälle (getrennt gezählt)</div>
        </section>
      )}
      {tasks && <p className="small muted">Stichtag {fmtDate(tasks.stichtag)}. Demonstrationswerte mit synthetischen Daten; keine Qualitätsrangliste.</p>}

      <section className="card" aria-label="Suche und Filter">
        <form className="grid grid-3" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <div className="field"><label htmlFor="q">Suche (Pseudonym oder Fallnummer)</label><input id="q" type="search" value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="z. B. D-1001 oder P-…" /></div>
          {me.centers.length > 1 && (
            <div className="field"><label htmlFor="c">Zentrum</label><select id="c" value={f.centerId} onChange={(e) => set({ centerId: e.target.value })}><option value="">Alle</option>{me.centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          )}
          <div className="field"><label htmlFor="op">Operateur/in</label><select id="op" value={f.surgeonId} onChange={(e) => set({ surgeonId: e.target.value })}><option value="">Alle</option>{surgeons.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}</select></div>
          <div className="field"><label htmlFor="r">Register</label><select id="r" value={f.register} onChange={(e) => set({ register: e.target.value })}><option value="">Alle</option><option value="DART">DART</option><option value="KNORPEL_DGOU">KnorpelRegister DGOU</option><option value="DEKOR">DEKOR</option></select></div>
          <div className="field"><label htmlFor="m">Modus</label><select id="m" value={f.mode} onChange={(e) => set({ mode: e.target.value })}><option value="">Alle</option><option value="basic">DART Basic</option><option value="science">DART Science</option></select></div>
          <div className="field"><label htmlFor="mo">Modul/Eingriff</label><select id="mo" value={f.module} onChange={(e) => set({ module: e.target.value })}><option value="">Alle</option>{Object.entries(MODULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="s">Status</label><select id="s" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Alle</option><option value="consent_ausstehend">Einwilligung ausstehend</option><option value="aktiv">Aktiv</option><option value="arztbogen_offen">Arztbogen offen</option><option value="ueberfaellig">Befragung überfällig</option><option value="gesperrt">Gesperrt</option></select></div>
          <div className="field"><label htmlFor="from">Bezugsdatum von</label><DateInput id="from" value={f.from} onChange={(iso) => set({ from: iso })} /></div>
          <div className="field"><label htmlFor="to">Bezugsdatum bis</label><DateInput id="to" value={f.to} onChange={(iso) => set({ to: iso })} /></div>
          <div className="field" style={{ alignSelf: 'end' }}><button type="button" className="btn-ghost" onClick={() => setF({ q: '', centerId: '', surgeonId: '', register: '', mode: '', status: '', module: '', from: '', to: '', page: 1 })}>Filter zurücksetzen</button></div>
        </form>
      </section>

      {loading && <Loading what="Fälle" />}
      {!loading && list && list.items.length === 0 && (
        <Alert kind="info" title="Keine Fälle gefunden">Es gibt keine Fälle zu diesen Filtern. {can(me, 'case.write') && <Link href="/faelle/neu">Neuen Fall anlegen</Link>}</Alert>
      )}
      {!loading && list && list.items.length > 0 && (
        <>
          <p className="small muted" aria-live="polite">{list.totalCases} Fälle von {list.totalPatients} Patientinnen/Patienten · Seite {list.page} von {pages}</p>
          <div className="table-wrap">
            <table className="data cards">
              <caption className="sr-only">Behandlungsfälle</caption>
              <thead><tr><th scope="col">Fall</th><th scope="col">Pseudonym</th><th scope="col">Gelenk / Seite</th><th scope="col">Bezugsdatum</th><th scope="col">Modus / Module</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {list.items.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Fall"><Link href={`/faelle/${c.id}`}><strong>{c.case_no}</strong></Link><div className="small muted">{c.center_name}</div></td>
                    <td data-label="Pseudonym">{c.pseudonym}</td>
                    <td data-label="Gelenk / Seite">{JOINT_LABEL[c.joint]} {c.side}<div className="small muted">{c.treatment_type === 'operativ' ? 'operativ' : 'konservativ'}</div></td>
                    <td data-label="Bezugsdatum">{fmtDate(c.actual_op_date ?? c.planned_op_date ?? c.conservative_start_date)}<div className="small muted">{c.actual_op_date ? 'OP erfolgt' : c.planned_op_date ? 'OP geplant' : 'Behandlungsbeginn'}</div></td>
                    <td data-label="Modus / Module">{c.mode === 'science' ? 'Science' : 'Basic'}<div className="small">{[...c.modules.map((m) => MODULE_LABEL[m] ?? m), ...c.registers.filter((r) => r !== 'DART').map((r) => REG_LABEL[r])].join(' + ') || 'Basis'}</div></td>
                    <td data-label="Status"><div className="stack" style={{ display: 'grid', gap: 4, justifyItems: 'start' }}><Badge tone={c.status === 'aktiv' ? 'ok' : c.status === 'consent_ausstehend' ? 'warn' : 'bad'}>{CASE_STATUS_LABEL[c.status]}</Badge><ConsentBadge status={c.consent_status} />{c.open_physician_forms > 0 && <Badge tone="info">{c.open_physician_forms} Arztbogen offen</Badge>}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="row" aria-label="Seiten" style={{ marginTop: 12 }}>
            <button className="btn-ghost btn-small" disabled={f.page <= 1} onClick={() => setF((p) => ({ ...p, page: p.page - 1 }))}>Zurück</button>
            <span className="small">Seite {f.page} von {pages}</span>
            <button className="btn-ghost btn-small" disabled={f.page >= pages} onClick={() => setF((p) => ({ ...p, page: p.page + 1 }))}>Weiter</button>
          </nav>
        </>
      )}

      {can(me, 'identity.read') && (
        <section className="card" style={{ marginTop: 24 }} aria-labelledby="ns">
          <h2 id="ns">Klarnamensuche (geschützter Identitätsdienst)</h2>
          <p className="small muted">Die Suche erfolgt im getrennten Identity Vault, nur für Ihre Zentren, und wird protokolliert. Der Forschungsindex enthält keine Namen.</p>
          <form className="row" onSubmit={searchName}>
            <label htmlFor="ln" className="sr-only">Nachname</label>
            <input id="ln" type="search" style={{ maxWidth: 320 }} value={nameQ} onChange={(e) => setNameQ(e.target.value)} placeholder="Nachname (exakt)" />
            <button type="submit" className="btn-secondary" disabled={nameQ.trim().length < 2}>Suchen</button>
          </form>
          {nameHits && (nameHits.length === 0 ? <p className="small">Keine Treffer.</p> : (
            <ul>{nameHits.map((h) => <li key={h.case_id ?? h.pseudonym}>{h.case_id ? <Link href={`/faelle/${h.case_id}`}>{h.case_no}</Link> : null} – {h.pseudonym} ({JOINT_LABEL[h.joint] ?? ''} {h.side ?? ''})</li>)}</ul>
          ))}
        </section>
      )}
    </>
  );
}
