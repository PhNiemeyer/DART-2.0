'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MISSING_CODES, MissingCode, AnswerValue } from '@dart/forms';
import { api, ApiErr } from '@/lib/api';
import { fmtDateTime, RESPONSE_STATUS_LABEL } from '@/lib/format';
import { FormRenderer } from '@/components/FormRenderer';
import { ConflictInfo, SaveIndicator, useResponseEditor } from '@/components/useResponseEditor';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

const MOD: Record<string, string> = { BASIS: 'Basis', MENISKUS: 'Meniskus', KREUZBAND: 'VKB/HKB', PATELLA: 'Patella', KNORPEL: 'Knorpel', OSTEOTOMIE: 'Osteotomie', ENDOPROTHETIK: 'Endoprothetik', SYNOVITIS: 'Synovitis' };

function show(a: AnswerValue | undefined): string {
  if (!a) return '–';
  if (a.missing) return `Fehlgrund: ${MISSING_CODES[a.missing as MissingCode] ?? a.missing}`;
  if (Array.isArray(a.value)) return a.value.join(', ');
  return String(a.value ?? '–').replace(/^(-?\d+)\.(\d+)$/, '$1,$2');
}

function ConflictView({ conflict, mine, onKeepMine, onTakeServer }: { conflict: ConflictInfo; mine: Record<string, AnswerValue>; onKeepMine: () => void; onTakeServer: () => void }) {
  const keys = [...new Set([...Object.keys(conflict.serverAnswers), ...Object.keys(mine)])].filter((k) => JSON.stringify(conflict.serverAnswers[k]) !== JSON.stringify(mine[k]));
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Konflikt: Der Bogen wurde inzwischen geändert</strong>
      <p className="small" style={{ margin: '4px 0' }}>Geändert von {conflict.changedBy ?? 'einer anderen Person'} am {fmtDateTime(conflict.changedAt)} (Revision {conflict.currentRevision}). Ihre Eingaben wurden nicht überschrieben und nicht verworfen.</p>
      <div className="diff" style={{ fontWeight: 600, marginTop: 8 }}><span>Feld</span><span>Serverstand</span><span>Ihre Eingabe</span></div>
      {keys.map((k) => <div key={k} className="diff"><span>{k}</span><span>{show(conflict.serverAnswers[k])}</span><span>{show(mine[k])}</span></div>)}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn-small" onClick={onKeepMine}>Meine Eingaben auf den Serverstand anwenden</button>
        <button className="btn-ghost btn-small" onClick={onTakeServer}>Serverstand übernehmen (meine Änderungen verwerfen)</button>
      </div>
    </div>
  );
}

export default function FormPage() {
  const { id, rid } = useParams<{ id: string; rid: string }>();
  const ed = useResponseEditor('/responses', rid);
  const [caseInfo, setCaseInfo] = useState<any>(null);
  const [showRequired, setShowRequired] = useState(false);
  const [submitError, setSubmitError] = useState<ApiErr | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [history, setHistory] = useState<any>(null);

  useEffect(() => {
    api(`/cases/${id}`).then(setCaseInfo).catch(() => undefined);
  }, [id, ed.resp?.status]);

  if (ed.loadError) return <ErrorBox error={ed.loadError} onRetry={ed.reload} />;
  if (!ed.resp || !ed.evaluation) return <Loading what="Bogen" />;
  const r = ed.resp;
  const ev = ed.evaluation;
  const readOnly = r.status === 'abgeschlossen' || r.audience === 'patient';
  const pct = ev.progress.total ? Math.round((ev.progress.answered / ev.progress.total) * 100) : 100;
  const physician = caseInfo?.responses?.filter((x: any) => x.audience === 'arzt') ?? [];

  async function submit() {
    setShowRequired(true);
    setSubmitError(null);
    try {
      await ed.submit();
      setDone('Bogen abgeschlossen. Die Angaben wurden serverseitig geprüft und versioniert gespeichert.');
    } catch (e) {
      setSubmitError(e as ApiErr);
      setTimeout(() => document.getElementById('fehler')?.focus(), 0);
    }
  }

  return (
    <>
      <p className="small"><Link href={`/faelle/${id}`}>← Zurück zu Fall {caseInfo?.case?.case_no ?? ''}</Link></p>
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>{r.audience === 'arzt' ? 'Arztbogen' : 'Patientenbefragung'} · {caseInfo?.case?.case_no ?? ''}</h1>
        {!readOnly && <SaveIndicator state={ed.state} lastSaved={ed.lastSaved} error={ed.saveError} onRetry={ed.retry} />}
        {readOnly && <Badge tone={r.status === 'abgeschlossen' ? 'ok' : 'info'}>{RESPONSE_STATUS_LABEL[r.status]}{r.audience === 'patient' ? ' · nur lesen' : ''}</Badge>}
      </div>
      <p className="small muted">{r.schema.title} · Formularversion {r.questionnaire.version} · SHA-256 {r.questionnaire.hash?.slice(0, 12)}… · Zeitpunkt {r.timepoint}</p>
      <ConceptNote />
      {physician.length > 1 && (
        <nav className="row" aria-label="Module dieses Falls" style={{ marginBottom: 12 }}>
          {physician.map((x: any) => <Link key={x.id} className="chip" href={`/faelle/${id}/boegen/${x.id}`} aria-current={x.id === rid ? 'page' : undefined}>{MOD[x.module_code] ?? x.module_code}{x.status === 'abgeschlossen' ? ' ✓' : ''}</Link>)}
        </nav>
      )}
      {done && <Alert kind="success">{done}</Alert>}
      {ed.conflict && <ConflictView conflict={ed.conflict} mine={ed.answers} onKeepMine={ed.resolveKeepMine} onTakeServer={ed.resolveTakeServer} />}
      {submitError && (
        <div id="fehler" tabIndex={-1}>
          <ErrorBox error={submitError} />
        </div>
      )}
      {!readOnly && (
        <div className="card" style={{ padding: 16 }}>
          <div className="row between small"><span>Fortschritt: {ev.progress.answered} von {ev.progress.total} Angaben</span><span>{ev.progress.requiredOpen > 0 ? `${ev.progress.requiredOpen} Pflichtangabe(n) noch offen` : 'Alle Pflichtangaben erfasst'}</span></div>
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Fortschritt"><span style={{ width: `${pct}%` }} /></div>
        </div>
      )}
      <FormRenderer schema={r.schema} data={{ answers: ed.answers, instances: ed.instances }} evaluation={ev} readOnly={readOnly} showRequired={showRequired} onChange={ed.change} onInstances={ed.changeInstances} />
      {!readOnly && (
        <div className="sticky-actions">
          <SaveIndicator state={ed.state} lastSaved={ed.lastSaved} error={ed.saveError} onRetry={ed.retry} />
          <button onClick={submit} disabled={ed.state === 'konflikt'}>Prüfen und abschließen</button>
        </div>
      )}
      {r.status === 'abgeschlossen' && r.audience === 'arzt' && caseInfo?.canFinalize && (
        <section className="card">
          <h2>Wiederöffnen</h2>
          <p className="small muted">Nur mit Begründung. Der abgeschlossene Stand bleibt als Revision erhalten.</p>
          <div className="row">
            <label htmlFor="rr" className="sr-only">Begründung</label>
            <input id="rr" type="text" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} placeholder="Begründung (mind. 5 Zeichen)" style={{ maxWidth: 420 }} />
            <button className="btn-secondary" disabled={reopenReason.trim().length < 5} onClick={() => api(`/responses/${rid}/reopen`, { body: { reason: reopenReason } }).then(() => { setDone(null); setReopenReason(''); return ed.reload(); }).catch(setSubmitError)}>Wiederöffnen</button>
          </div>
        </section>
      )}
      <details className="card">
        <summary onClick={() => !history && api(`/responses/${rid}/history`).then(setHistory).catch(() => undefined)}>Revisionsverlauf</summary>
        {history && (
          <ul className="small">
            {history.revisions.map((h: any) => <li key={h.revision}>Revision {h.revision}: {h.action} · {fmtDateTime(h.created_at)} · {h.changed_by ?? (h.changed_by_patient ? 'Patient/in' : 'System')}{h.reason ? ` · Grund: ${h.reason}` : ''}{h.inactive_keys?.length ? ` · inaktiv: ${h.inactive_keys.join(', ')}` : ''}</li>)}
            {history.scores.map((s: any, i: number) => <li key={`s${i}`}>Score {s.algorithm} ({s.kind}) = {s.value ?? '–'} {s.reason ? `(${s.reason})` : ''} · Revision {s.response_revision}</li>)}
          </ul>
        )}
      </details>
    </>
  );
}
