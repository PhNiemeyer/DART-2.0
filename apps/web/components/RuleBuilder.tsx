'use client';
import { useState } from 'react';
import { Condition, CONDITION_OP_LABELS, ConditionOp, describeRule, draftFromRule, FormSchema, opsForType, Rule, RuleDraft, RuleField, ruleFromDraft } from '@dart/forms';

/**
 * Verzweigungsassistent (R-10): Bedingungen per Auswahl statt JSON.
 * Komplexe Regeln, die der Assistent nicht darstellen kann, bleiben unverändert und sind nur als JSON bearbeitbar.
 */
export function RuleBuilder({ id, rule, fields, schema, onChange, disabled, label = 'Sichtbar wenn' }: {
  id: string;
  rule: Rule | undefined;
  fields: RuleField[];
  schema: FormSchema;
  onChange: (r: Rule | undefined) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState<RuleDraft | null>(() => draftFromRule(rule));
  const [json, setJson] = useState(rule ? JSON.stringify(rule) : '');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const byId = new Map(fields.map((f) => [f.id, f]));

  const commit = (d: RuleDraft) => {
    setDraft(d);
    const r = ruleFromDraft(d);
    setJson(r ? JSON.stringify(r) : '');
    setJsonErr(null);
    onChange(r);
  };
  const setCond = (i: number, c: Partial<Condition>) => {
    if (!draft) return;
    const conditions = draft.conditions.map((x, j) => (j === i ? { ...x, ...c } : x));
    commit({ ...draft, conditions });
  };

  return (
    <fieldset className="rule-builder" disabled={disabled}>
      <legend>{label}</legend>
      {draft ? (
        <>
          {draft.conditions.length === 0 && <p className="small muted" style={{ margin: 0 }}>Keine Bedingung: Das Feld ist immer sichtbar.</p>}
          {draft.conditions.length > 1 && (
            <div className="field">
              <label htmlFor={`${id}-mode`}>Verknüpfung</label>
              <select id={`${id}-mode`} value={draft.mode} onChange={(e) => commit({ ...draft, mode: e.target.value as 'all' | 'any' })}>
                <option value="all">Alle Bedingungen müssen erfüllt sein (und)</option>
                <option value="any">Mindestens eine Bedingung (oder)</option>
              </select>
            </div>
          )}
          {draft.conditions.map((c, i) => {
            const f = byId.get(c.field);
            const ops = f ? opsForType(f.type) : (Object.keys(CONDITION_OP_LABELS) as ConditionOp[]);
            const needsValue = !['beantwortet', 'nicht_beantwortet'].includes(c.op);
            const cid = `${id}-c${i}`;
            return (
              <div key={i} className="rule-row">
                <div className="field">
                  <label htmlFor={`${cid}-f`}>Feld</label>
                  <select id={`${cid}-f`} value={c.field} onChange={(e) => { const nf = byId.get(e.target.value); setCond(i, { field: e.target.value, op: nf ? opsForType(nf.type)[0] : c.op, value: undefined }); }}>
                    {!f && <option value={c.field}>{c.field} (nicht verfügbar)</option>}
                    {fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${cid}-o`}>Bedingung</label>
                  <select id={`${cid}-o`} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as ConditionOp, value: e.target.value === 'einer_von' ? [] : undefined })}>
                    {ops.map((o) => <option key={o} value={o}>{CONDITION_OP_LABELS[o]}</option>)}
                  </select>
                </div>
                {needsValue && (
                  <div className="field">
                    {c.op === 'einer_von' && f ? (
                      <fieldset>
                        <legend className="small">Werte</legend>
                        {f.codes.map((k) => {
                          const list = Array.isArray(c.value) ? c.value : [];
                          return <label key={k.code} className="choice small"><input type="checkbox" checked={list.includes(k.code)} onChange={(e) => setCond(i, { value: e.target.checked ? [...list, k.code] : list.filter((x) => x !== k.code) })} />{k.label}</label>;
                        })}
                      </fieldset>
                    ) : f && f.codes.length > 0 ? (
                      <>
                        <label htmlFor={`${cid}-v`}>Wert</label>
                        <select id={`${cid}-v`} value={typeof c.value === 'string' ? c.value : ''} onChange={(e) => setCond(i, { value: e.target.value || undefined })}>
                          <option value="">– bitte wählen –</option>
                          {f.codes.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
                        </select>
                      </>
                    ) : (
                      <>
                        <label htmlFor={`${cid}-v`}>{f?.type === 'date' ? 'Datum (JJJJ-MM-TT)' : 'Wert'}</label>
                        <input id={`${cid}-v`} type="text" inputMode={f?.type === 'date' ? 'numeric' : 'decimal'} value={c.value === undefined || Array.isArray(c.value) ? '' : String(c.value)}
                          onChange={(e) => { const t = e.target.value.trim(); const n = Number(t.replace(',', '.')); setCond(i, { value: t === '' ? undefined : f?.type === 'date' || Number.isNaN(n) ? t : n }); }} />
                      </>
                    )}
                  </div>
                )}
                <button type="button" className="btn-ghost btn-small" onClick={() => commit({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })} aria-label={`Bedingung ${i + 1} entfernen`}>Entfernen</button>
              </div>
            );
          })}
          <button type="button" className="btn-ghost btn-small" disabled={fields.length === 0} onClick={() => commit({ ...draft, conditions: [...draft.conditions, { field: fields[0].id, op: opsForType(fields[0].type)[0] }] })}>Bedingung hinzufügen</button>
          {fields.length === 0 && <span className="small muted"> Keine Felder verfügbar, auf die sich eine Bedingung beziehen kann.</span>}
        </>
      ) : (
        <p className="small" style={{ margin: 0 }}>Diese Regel ist für den Assistenten zu komplex und kann nur als JSON bearbeitet werden.</p>
      )}
      <p className="small" style={{ margin: '6px 0 0' }}><strong>Klartext:</strong> {describeRule(rule, schema)}</p>
      <details>
        <summary className="small">Experten: Regel als JSON (Regel-DSL)</summary>
        <div className="field">
          <label htmlFor={`${id}-json`}>Regel-DSL (JSON; leer = immer sichtbar)</label>
          <input id={`${id}-json`} type="text" value={json} placeholder='{"eq":[{"var":"feld"},"ja"]}' aria-invalid={!!jsonErr} onChange={(e) => {
            setJson(e.target.value);
            if (!e.target.value.trim()) { setJsonErr(null); setDraft({ mode: 'all', conditions: [] }); onChange(undefined); return; }
            try { const r = JSON.parse(e.target.value) as Rule; setJsonErr(null); setDraft(draftFromRule(r)); onChange(r); } catch { setJsonErr('Kein gültiges JSON'); }
          }} />
          <div className="help">Erlaubt: all, any, not, eq, in, exists, gt, gte, lt, lte. Kein ausführbarer Code.</div>
          {jsonErr && <div className="field-error">{jsonErr}</div>}
        </div>
      </details>
    </fieldset>
  );
}
