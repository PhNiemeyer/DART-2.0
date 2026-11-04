'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnswerMap, evaluateForm, FormItem, FormSchema, ITEM_TYPE_LABELS, ITEM_TYPES, ItemType, MISSING_CODES, MissingCode, ruleFieldsFor, validateSchema } from '@dart/forms';
import { api, ApiErr } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { FormRenderer } from '@/components/FormRenderer';
import { RuleBuilder } from '@/components/RuleBuilder';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

const ST: Record<string, string> = { entwurf: 'Entwurf', in_pruefung: 'In Prüfung', freigegeben: 'Freigegeben', veroeffentlicht: 'Veröffentlicht', ruhestand: 'Ruhestand' };

function codesToText(item: FormItem) {
  return (item.codes ?? []).map((c) => `${c.code}=${c.label}`).join('\n');
}

function ItemEditor({ item, schema, onChange, onRemove, onMove, readOnly }: { item: FormItem; schema: FormSchema; onChange: (i: FormItem) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; readOnly: boolean }) {
  const [codes, setCodes] = useState(codesToText(item));
  const up = (p: Partial<FormItem>) => onChange({ ...item, ...p });
  const pid = `it-${item.id}`;
  return (
    <fieldset disabled={readOnly}>
      <legend>{item.id} · {ITEM_TYPE_LABELS[item.type]}</legend>
      <div className="grid grid-2">
        <div className="field"><label htmlFor={`${pid}-l`}>Deutsches Label</label><input id={`${pid}-l`} type="text" value={item.label} onChange={(e) => up({ label: e.target.value })} /></div>
        <div className="field"><label htmlFor={`${pid}-t`}>Datentyp</label><select id={`${pid}-t`} value={item.type} onChange={(e) => up({ type: e.target.value as ItemType })}>{ITEM_TYPES.filter((t) => t !== 'group').map((t) => <option key={t} value={t}>{ITEM_TYPE_LABELS[t]}</option>)}</select></div>
        <div className="field"><label htmlFor={`${pid}-v`}>Stabile Variablenkennung</label><input id={`${pid}-v`} type="text" value={item.varId} onChange={(e) => up({ varId: e.target.value })} /></div>
        <div className="field"><label htmlFor={`${pid}-u`}>Einheit</label><input id={`${pid}-u`} type="text" value={item.unit ?? ''} onChange={(e) => up({ unit: e.target.value || undefined })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor={`${pid}-h`}>Hilfetext</label><input id={`${pid}-h`} type="text" value={item.help ?? ''} onChange={(e) => up({ help: e.target.value || undefined })} /></div>
        {item.type === 'number' && (
          <>
            <div className="field"><label htmlFor={`${pid}-min`}>Minimum</label><input id={`${pid}-min`} type="number" value={item.min ?? ''} onChange={(e) => up({ min: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor={`${pid}-max`}>Maximum</label><input id={`${pid}-max`} type="number" value={item.max ?? ''} onChange={(e) => up({ max: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor={`${pid}-d`}>Nachkommastellen</label><input id={`${pid}-d`} type="number" min={0} max={6} value={item.decimals ?? ''} onChange={(e) => up({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
          </>
        )}
        {(item.type === 'single' || item.type === 'multi') && (
          <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor={`${pid}-c`}>Codes (eine Zeile je Code: code=Bezeichnung)</label><textarea id={`${pid}-c`} rows={4} value={codes} onChange={(e) => { setCodes(e.target.value); up({ codes: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return i < 0 ? { code: l, label: l } : { code: l.slice(0, i).trim(), label: l.slice(i + 1).trim() }; }) }); }} /></div>
        )}
        <div style={{ gridColumn: '1 / -1' }}>
          <RuleBuilder id={`${pid}-r`} rule={item.visibleIf} fields={ruleFieldsFor(schema, item.id)} schema={schema} disabled={readOnly} label="Verzweigung: sichtbar wenn" onChange={(r) => up({ visibleIf: r })} />
        </div>
      </div>
      <div className="row">
        <label className="choice"><input type="checkbox" checked={!!item.required} onChange={(e) => up({ required: e.target.checked })} />Pflichtfeld</label>
        {(Object.keys(MISSING_CODES) as MissingCode[]).filter((m) => m !== 'historisch_leer').map((m) => <label key={m} className="choice small"><input type="checkbox" checked={(item.allowedMissing ?? []).includes(m)} onChange={(e) => up({ allowedMissing: e.target.checked ? [...(item.allowedMissing ?? []), m] : (item.allowedMissing ?? []).filter((x) => x !== m) })} />Fehlgrund: {MISSING_CODES[m]}</label>)}
      </div>
      <div className="row">
        <button type="button" className="btn-ghost btn-small" onClick={() => onMove(-1)}>Nach oben</button>
        <button type="button" className="btn-ghost btn-small" onClick={() => onMove(1)}>Nach unten</button>
        <button type="button" className="btn-ghost btn-small" onClick={onRemove}>Feld entfernen</button>
      </div>
    </fieldset>
  );
}

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 36).toString(36)}`;

/** Wiederholbare Gruppe (R-10): Kopf, Wiederholungsgrenzen, Sichtbarkeit und Felder der Gruppe. Keine verschachtelten Gruppen. */
function GroupEditor({ group, schema, onChange, onRemove, onMove, readOnly }: { group: FormItem; schema: FormSchema; onChange: (g: FormItem) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; readOnly: boolean }) {
  const up = (p: Partial<FormItem>) => onChange({ ...group, ...p });
  const rep = group.repeat ?? { min: 0, max: 1, instanceLabel: 'Eintrag' };
  const children = group.items ?? [];
  const setChild = (i: number, c: FormItem | null) => {
    const items = [...children];
    if (c) items[i] = c;
    else items.splice(i, 1);
    up({ items });
  };
  const moveChild = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= children.length) return;
    const items = [...children];
    [items[i], items[j]] = [items[j], items[i]];
    up({ items });
  };
  const pid = `gr-${group.id}`;
  return (
    <fieldset className="group-editor" disabled={readOnly}>
      <legend>Wiederholbare Gruppe {group.id} · {children.length} Feld(er)</legend>
      <div className="grid grid-2">
        <div className="field"><label htmlFor={`${pid}-l`}>Bezeichnung der Gruppe</label><input id={`${pid}-l`} type="text" value={group.label} onChange={(e) => up({ label: e.target.value })} /></div>
        <div className="field"><label htmlFor={`${pid}-il`}>Bezeichnung eines Eintrags</label><input id={`${pid}-il`} type="text" value={rep.instanceLabel} onChange={(e) => up({ repeat: { ...rep, instanceLabel: e.target.value } })} /></div>
        <div className="field"><label htmlFor={`${pid}-min`}>Mindestanzahl Einträge</label><input id={`${pid}-min`} type="number" min={0} max={50} value={rep.min} onChange={(e) => up({ repeat: { ...rep, min: Number(e.target.value) } })} /></div>
        <div className="field"><label htmlFor={`${pid}-max`}>Höchstanzahl Einträge</label><input id={`${pid}-max`} type="number" min={1} max={50} value={rep.max} onChange={(e) => up({ repeat: { ...rep, max: Number(e.target.value) } })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor={`${pid}-h`}>Hilfetext</label><input id={`${pid}-h`} type="text" value={group.help ?? ''} onChange={(e) => up({ help: e.target.value || undefined })} /></div>
        <div style={{ gridColumn: '1 / -1' }}>
          <RuleBuilder id={`${pid}-r`} rule={group.visibleIf} fields={ruleFieldsFor(schema, group.id)} schema={schema} disabled={readOnly} label="Gruppe sichtbar wenn" onChange={(r) => up({ visibleIf: r })} />
        </div>
      </div>
      <div className="stack" style={{ gap: 12, marginTop: 12 }}>
        {children.map((c, i) => <ItemEditor key={c.id} item={c} schema={schema} readOnly={readOnly} onChange={(n) => setChild(i, n)} onRemove={() => setChild(i, null)} onMove={(d) => moveChild(i, d)} />)}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {!readOnly && <button type="button" className="btn-secondary btn-small" onClick={() => { const id = newId('g'); up({ items: [...children, { id, varId: `${group.varId}_${id.toUpperCase()}`, label: 'Neues Gruppenfeld (Beispiel)', type: 'text' }] }); }}>Feld in Gruppe hinzufügen</button>}
        <button type="button" className="btn-ghost btn-small" onClick={() => onMove(-1)}>Gruppe nach oben</button>
        <button type="button" className="btn-ghost btn-small" onClick={() => onMove(1)}>Gruppe nach unten</button>
        <button type="button" className="btn-ghost btn-small" onClick={onRemove}>Gruppe entfernen</button>
      </div>
    </fieldset>
  );
}

export default function Editor() {
  const { vid } = useParams<{ vid: string }>();
  const me = useMe();
  const [v, setV] = useState<any>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ answers: AnswerMap; instances: Record<string, string[]> }>({ answers: {}, instances: {} });
  const [rejectReason, setRejectReason] = useState('');
  const [editorKey, setEditorKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api(`/form-versions/${vid}`);
      setV(r);
      setSchema(r.schema);
      setDirty(false);
      setEditorKey((k) => k + 1);
    } catch (e) {
      setError(e as ApiErr);
    }
  }, [vid]);
  useEffect(() => { void load(); }, [load]);

  const errors = useMemo(() => (schema ? validateSchema(schema) : []), [schema]);
  const evaluation = useMemo(() => (schema && errors.length === 0 ? evaluateForm(schema, preview) : null), [schema, preview, errors]);
  if (error && !v) return <ErrorBox error={error} />;
  if (!v || !schema) return <Loading what="Formularversion" />;
  const editable = v.status === 'entwurf' && can(me, 'form.draft');

  const updateItem = (si: number, ii: number, item: FormItem) => {
    const s = structuredClone(schema);
    s.sections[si].items[ii] = item;
    setSchema(s);
    setDirty(true);
  };
  const act = (path: string, ok: string, body: unknown = {}) => api(path, { body }).then(() => { setMsg(ok); setError(null); return load(); }).catch(setError);

  async function save() {
    try {
      await api(`/form-versions/${vid}`, { method: 'PUT', body: { schema } });
      setMsg('Entwurf gespeichert.');
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e as ApiErr);
    }
  }
  async function exportJson() {
    const r = await api(`/form-versions/${vid}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.code}-V${r.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <p className="small"><Link href="/formulare">← Alle Formulare</Link></p>
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>{v.code} · Version {v.version}</h1>
        <Badge tone={v.status === 'veroeffentlicht' ? 'ok' : v.status === 'entwurf' ? 'info' : 'warn'}>{ST[v.status]}</Badge>
      </div>
      <p className="small muted">Autor: {v.author_name ?? '–'} · Freigabe: {v.approver_name ?? '–'} · Veröffentlicht: {v.published_at ? `${fmtDateTime(v.published_at)} durch ${v.publisher_name}` : '–'} · Hash: {v.schema_hash ? `${v.schema_hash.slice(0, 16)}…` : 'wird bei Prüfung berechnet'}</p>
      <ConceptNote />
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      {errors.length > 0 && (
        <Alert kind="warning" title={`Schemaprüfung: ${errors.length} Problem(e) – Veröffentlichung nicht möglich`}>
          <ul>{errors.slice(0, 15).map((e, i) => <li key={i}>{e.message} <span className="small muted">({e.path})</span></li>)}</ul>
        </Alert>
      )}
      <div className="card row">
        {editable && <button onClick={save} disabled={!dirty}>Entwurf speichern</button>}
        {editable && <button className="btn-secondary" disabled={dirty || errors.length > 0} onClick={() => act(`/form-versions/${vid}/submit-review`, 'Zur Prüfung eingereicht.')}>Zur Prüfung einreichen</button>}
        {v.status === 'in_pruefung' && can(me, 'form.publish') && <button disabled={v.author_id === me.userId} onClick={() => act(`/form-versions/${vid}/approve`, 'Freigegeben (Vier-Augen-Prinzip).')}>Freigeben</button>}
        {v.status === 'freigegeben' && can(me, 'form.publish') && <button onClick={() => act(`/form-versions/${vid}/publish`, 'Veröffentlicht. Neue Fälle verwenden diese Version; laufende Erhebungen behalten ihre Version.')}>Veröffentlichen</button>}
        {['in_pruefung', 'freigegeben'].includes(v.status) && can(me, 'form.publish') && (
          <span className="row"><label htmlFor="rj" className="sr-only">Begründung</label><input id="rj" type="text" placeholder="Begründung" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} style={{ maxWidth: 240 }} /><button className="btn-ghost" disabled={rejectReason.length < 5} onClick={() => act(`/form-versions/${vid}/reject`, 'Zurück in den Entwurf.', { reason: rejectReason })}>Zurückweisen</button></span>
        )}
        {v.status === 'veroeffentlicht' && can(me, 'form.publish') && <button className="btn-ghost" onClick={() => act(`/form-versions/${vid}/retire`, 'In den Ruhestand versetzt.')}>Ruhestand</button>}
        <button className="btn-ghost" onClick={exportJson}>JSON exportieren</button>
        {v.version > 1 && <Link className="btn btn-ghost" href={`/formulare/${vid}/vergleich`}>Mit Vorgängerversion vergleichen</Link>}
        {!editable && <span className="small muted">{v.status === 'entwurf' ? 'Nur die Formularredaktion kann Entwürfe bearbeiten.' : 'Diese Version ist nicht mehr bearbeitbar.'}</span>}
      </div>
      <div className="editor-grid">
        <div key={editorKey}>
          <h2>Struktur</h2>
          {schema.sections.map((s, si) => (
            <section key={s.id} className="card">
              <div className="field"><label htmlFor={`sec-${s.id}`}>Abschnittstitel</label><input id={`sec-${s.id}`} type="text" value={s.title} disabled={!editable} onChange={(e) => { const x = structuredClone(schema); x.sections[si].title = e.target.value; setSchema(x); setDirty(true); }} /></div>
              {s.items.map((it, ii) => {
                const remove = () => { const x = structuredClone(schema); x.sections[si].items.splice(ii, 1); setSchema(x); setDirty(true); setEditorKey((k) => k + 1); };
                const move = (d: -1 | 1) => { const x = structuredClone(schema); const arr = x.sections[si].items; const j = ii + d; if (j < 0 || j >= arr.length) return; [arr[ii], arr[j]] = [arr[j], arr[ii]]; setSchema(x); setDirty(true); setEditorKey((k) => k + 1); };
                return it.type === 'group'
                  ? <GroupEditor key={it.id} group={it} schema={schema} readOnly={!editable} onChange={(n) => updateItem(si, ii, n)} onRemove={remove} onMove={move} />
                  : <ItemEditor key={it.id} item={it} schema={schema} readOnly={!editable} onChange={(n) => updateItem(si, ii, n)} onRemove={remove} onMove={move} />;
              })}
              {editable && <button type="button" className="btn-secondary btn-small" onClick={() => { const x = structuredClone(schema); const n = x.sections[si].items.length + 1; const id = `neu_${si + 1}_${n}_${Date.now().toString(36).slice(-3)}`; x.sections[si].items.push({ id, varId: `${schema.code.replace(/-/g, '_')}_${id.toUpperCase()}`, label: 'Neue Frage (Beispiel)', type: 'yesno' }); setSchema(x); setDirty(true); setEditorKey((k) => k + 1); }}>Feld hinzufügen</button>}
              {editable && <button type="button" className="btn-secondary btn-small" style={{ marginLeft: 8 }} onClick={() => { const x = structuredClone(schema); const id = newId('gruppe'); x.sections[si].items.push({ id, varId: `${schema.code.replace(/-/g, '_')}_${id.toUpperCase()}`, label: 'Neue wiederholbare Gruppe (Beispiel)', type: 'group', repeat: { min: 0, max: 3, instanceLabel: 'Eintrag' }, items: [{ id: newId('g'), varId: `${schema.code.replace(/-/g, '_')}_${id.toUpperCase()}_F1`, label: 'Erstes Gruppenfeld (Beispiel)', type: 'text' }] }); setSchema(x); setDirty(true); setEditorKey((k) => k + 1); }}>Wiederholbare Gruppe hinzufügen</button>}
            </section>
          ))}
          {editable && <button type="button" className="btn-ghost" onClick={() => { const x = structuredClone(schema); x.sections.push({ id: `abschnitt_${x.sections.length + 1}`, title: 'Neuer Abschnitt', items: [] }); setSchema(x); setDirty(true); }}>Abschnitt hinzufügen</button>}
        </div>
        <div>
          <h2>Vorschau mit synthetischen Daten</h2>
          <p className="small muted">Regeln werden mit derselben Logik wie im Server ausgewertet. Eingaben hier werden nicht gespeichert.</p>
          {evaluation ? (
            <FormRenderer schema={schema} data={preview} evaluation={evaluation} showRequired onChange={(k, a) => setPreview((p) => { const answers = { ...p.answers }; if (a === null) delete answers[k]; else answers[k] = a; return { ...p, answers }; })} onInstances={(g, ids) => setPreview((p) => ({ ...p, instances: { ...p.instances, [g]: ids } }))} />
          ) : <Alert kind="info">Vorschau erst bei fehlerfreiem Schema.</Alert>}
        </div>
      </div>
    </>
  );
}
