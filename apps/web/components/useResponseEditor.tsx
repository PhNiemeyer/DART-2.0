'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnswerMap, AnswerValue, evaluateForm, FormSchema } from '@dart/forms';
import { api, ApiErr } from '@/lib/api';

export type SaveState = 'gespeichert' | 'speichert' | 'nicht_gespeichert' | 'konflikt' | 'abgeschlossen';

export interface ConflictInfo {
  currentRevision: number;
  serverAnswers: AnswerMap;
  serverInstances: Record<string, string[]>;
  changedBy: string | null;
  changedAt: string | null;
}

export interface LoadedResponse {
  id: string;
  caseId: string;
  status: string;
  audience: string;
  module: string;
  timepoint: string;
  revision: number;
  questionnaire: { code: string; version: number; hash: string };
  schema: FormSchema;
  answers: AnswerMap;
  instances: Record<string, string[]>;
  storedInactiveKeys: string[];
}

/**
 * Autosave mit Optimistic Locking (If-Match). Keine Offline-Speicherung von Gesundheitsdaten im Browser:
 * Ungespeicherte Änderungen existieren nur im Arbeitsspeicher und werden sichtbar als „Nicht gespeichert“ markiert.
 */
export function useResponseEditor(basePath: string, id: string) {
  const [resp, setResp] = useState<LoadedResponse | null>(null);
  const [loadError, setLoadError] = useState<ApiErr | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [instances, setInstances] = useState<Record<string, string[]>>({});
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SaveState>('gespeichert');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const pending = useRef<Record<string, AnswerValue | null>>({});
  const pendingInstances = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const revRef = useRef(0);
  const instRef = useRef<Record<string, string[]>>({});

  const load = useCallback(async () => {
    try {
      const r = await api<LoadedResponse>(`${basePath}/${id}`);
      setResp(r);
      setAnswers(r.answers);
      setInstances(r.instances ?? {});
      instRef.current = r.instances ?? {};
      setRevision(r.revision);
      revRef.current = r.revision;
      setState(r.status === 'abgeschlossen' ? 'abgeschlossen' : 'gespeichert');
      setLoadError(null);
    } catch (e) {
      setLoadError(e as ApiErr);
    }
  }, [basePath, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    if (inFlight.current) return;
    const delta = pending.current;
    const sendInstances = pendingInstances.current;
    if (Object.keys(delta).length === 0 && !sendInstances) return;
    pending.current = {};
    pendingInstances.current = false;
    inFlight.current = true;
    setState('speichert');
    const body: Record<string, unknown> = { answers: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v ?? { value: null }])) };
    if (sendInstances) body.instances = instRef.current;
    try {
      const r = await api<{ revision: number }>(`${basePath}/${id}/draft`, { method: 'PATCH', body, headers: { 'if-match': String(revRef.current) } });
      revRef.current = r.revision;
      setRevision(r.revision);
      setLastSaved(new Date());
      setSaveError(null);
      setState(Object.keys(pending.current).length || pendingInstances.current ? 'nicht_gespeichert' : 'gespeichert');
    } catch (e) {
      const err = e as ApiErr;
      // Änderungen bleiben im Speicher und werden beim nächsten Versuch erneut gesendet
      pending.current = { ...delta, ...pending.current };
      if (sendInstances) pendingInstances.current = true;
      if (err.status === 409 && err.code === 'KONFLIKT') {
        setConflict(err.body as ConflictInfo);
        setState('konflikt');
      } else {
        setSaveError(err.message);
        setState('nicht_gespeichert');
      }
    } finally {
      inFlight.current = false;
    }
    if ((Object.keys(pending.current).length || pendingInstances.current) && !conflictRef.current) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, id]);

  const conflictRef = useRef<ConflictInfo | null>(null);
  conflictRef.current = conflict;

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!conflictRef.current && !saveErrorRef.current) void flush();
    }, 700);
  }, [flush]);
  const saveErrorRef = useRef<string | null>(null);
  saveErrorRef.current = saveError;

  const change = useCallback(
    (key: string, v: AnswerValue | null) => {
      setAnswers((prev) => {
        const next = { ...prev };
        if (v === null) delete next[key];
        else next[key] = v;
        return next;
      });
      pending.current[key] = v;
      setState('nicht_gespeichert');
      schedule();
    },
    [schedule],
  );

  const changeInstances = useCallback(
    (groupId: string, ids: string[]) => {
      setInstances((prev) => {
        const next = { ...prev, [groupId]: ids };
        instRef.current = next;
        return next;
      });
      pendingInstances.current = true;
      setState('nicht_gespeichert');
      schedule();
    },
    [schedule],
  );

  /** Erneuter Versuch nach Fehler (Netz/Server). */
  const retry = useCallback(() => {
    setSaveError(null);
    saveErrorRef.current = null;
    void flush();
  }, [flush]);

  /** Konfliktlösung: eigene Änderungen auf den Serverstand anwenden (bewusste Entscheidung). */
  const resolveKeepMine = useCallback(() => {
    if (!conflict) return;
    revRef.current = conflict.currentRevision;
    setRevision(conflict.currentRevision);
    const mine = pending.current;
    setAnswers({ ...conflict.serverAnswers, ...Object.fromEntries(Object.entries(mine).filter(([, v]) => v !== null)) as AnswerMap });
    setConflict(null);
    conflictRef.current = null;
    void flush();
  }, [conflict, flush]);

  const resolveTakeServer = useCallback(() => {
    if (!conflict) return;
    pending.current = {};
    pendingInstances.current = false;
    revRef.current = conflict.currentRevision;
    setRevision(conflict.currentRevision);
    setAnswers(conflict.serverAnswers);
    setInstances(conflict.serverInstances ?? {});
    instRef.current = conflict.serverInstances ?? {};
    setConflict(null);
    setState('gespeichert');
  }, [conflict]);

  const evaluation = useMemo(() => (resp ? evaluateForm(resp.schema, { answers, instances }) : null), [resp, answers, instances]);

  // Warnung beim Verlassen mit ungespeicherten Änderungen
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (state === 'nicht_gespeichert' || state === 'speichert' || state === 'konflikt') e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state]);

  const submit = useCallback(async () => {
    await flush();
    if (Object.keys(pending.current).length || conflictRef.current) throw new ApiErr(409, 'KONFLIKT', 'Bitte zuerst den Speicherkonflikt lösen.', null);
    const r = await api(`${basePath}/${id}/submit`, { method: 'POST', body: {}, headers: { 'if-match': String(revRef.current), 'idempotency-key': `submit-${id}-${revRef.current}` } });
    await load();
    return r;
  }, [basePath, id, flush, load]);

  return { resp, loadError, answers, instances, revision, state, saveError, conflict, lastSaved, evaluation, change, changeInstances, retry, resolveKeepMine, resolveTakeServer, submit, reload: load, flush };
}

export function SaveIndicator({ state, lastSaved, error, onRetry }: { state: SaveState; lastSaved: Date | null; error: string | null; onRetry: () => void }) {
  const text: Record<SaveState, string> = {
    gespeichert: lastSaved ? `Gespeichert (${lastSaved.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})` : 'Gespeichert',
    speichert: 'Wird gespeichert …',
    nicht_gespeichert: error ? 'Nicht gespeichert' : 'Nicht gespeichert – wird gleich gespeichert',
    konflikt: 'Nicht gespeichert – Konflikt',
    abgeschlossen: 'Abgeschlossen (nur lesen)',
  };
  const cls = state === 'gespeichert' || state === 'abgeschlossen' ? 'saved' : state === 'speichert' ? 'saving' : 'error';
  return (
    <span className="row">
      <span className={`savestate ${cls}`} role="status" aria-live="polite">
        {cls === 'saved' ? '✓' : cls === 'saving' ? '…' : '!'} {text[state]}
      </span>
      {error && state === 'nicht_gespeichert' && (
        <>
          <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
          <button type="button" className="btn-small" onClick={onRetry}>Erneut speichern</button>
        </>
      )}
    </span>
  );
}
