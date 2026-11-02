'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiErr } from '@/lib/api';
import { FormRenderer } from '@/components/FormRenderer';
import { SaveIndicator, useResponseEditor } from '@/components/useResponseEditor';
import { Alert, ErrorBox, Loading } from '@/components/ui';

export default function Survey() {
  const { rid } = useParams<{ rid: string }>();
  const ed = useResponseEditor('/portal/responses', rid);
  const [showRequired, setShowRequired] = useState(false);
  const [err, setErr] = useState<ApiErr | null>(null);
  const [sectionIdx, setSectionIdx] = useState(0);
  if (ed.loadError) return <><ErrorBox error={ed.loadError} /><Link href="/portal">Zur Übersicht</Link></>;
  if (!ed.resp || !ed.evaluation) return <Loading what="Befragung" />;
  const r = ed.resp;
  const ev = ed.evaluation;
  const sections = r.schema.sections.filter((s) => ev.visibleSections.includes(s.id));
  const sec = sections[Math.min(sectionIdx, sections.length - 1)];
  const pct = ev.progress.total ? Math.round((ev.progress.answered / ev.progress.total) * 100) : 100;
  if (r.status === 'abgeschlossen') return (
    <>
      <Alert kind="success" title="Vielen Dank!">Ihre Antworten wurden gespeichert.</Alert>
      <Link className="btn" href="/portal">Zur Übersicht</Link>
    </>
  );
  return (
    <>
      <p className="small"><Link href="/portal">← Zur Übersicht (Ihre Angaben bleiben gespeichert)</Link></p>
      <h1>{r.schema.title}</h1>
      {r.schema.description && <p className="small muted">{r.schema.description}</p>}
      <div className="card" style={{ padding: 16 }}>
        <div className="row between small"><span>Abschnitt {sectionIdx + 1} von {sections.length}</span><span>{ev.progress.answered} von {ev.progress.total} beantwortet</span></div>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Fortschritt"><span style={{ width: `${pct}%` }} /></div>
        <div style={{ marginTop: 8 }}><SaveIndicator state={ed.state} lastSaved={ed.lastSaved} error={ed.saveError} onRetry={ed.retry} /></div>
      </div>
      {ed.conflict && <Alert kind="warning" title="Ihre Befragung wurde in einem anderen Fenster geändert">Bitte laden Sie die Seite neu. <button className="btn-small" onClick={ed.resolveTakeServer}>Neuesten Stand laden</button></Alert>}
      <ErrorBox error={err} />
      <FormRenderer schema={r.schema} data={{ answers: ed.answers, instances: ed.instances }} evaluation={ev} showRequired={showRequired} onChange={ed.change} onInstances={ed.changeInstances} sectionFilter={(id) => id === sec?.id} />
      <div className="row between">
        <button className="btn-ghost" disabled={sectionIdx === 0} onClick={() => { setSectionIdx((i) => i - 1); window.scrollTo(0, 0); }}>Zurück</button>
        {sectionIdx < sections.length - 1 ? (
          <button onClick={() => { setSectionIdx((i) => i + 1); window.scrollTo(0, 0); }}>Weiter</button>
        ) : (
          <button onClick={async () => { setShowRequired(true); setErr(null); try { await ed.submit(); } catch (e) { setErr(e as ApiErr); } }}>Antworten absenden</button>
        )}
      </div>
    </>
  );
}
