'use client';
import { useEffect, useId, useState } from 'react';
import { answerKey, AnswerValue, FormEvaluation, FormItem, FormSchema, Issue, MISSING_CODES, MissingCode, ResponseData, YESNO_CODES } from '@dart/forms';
import { fmtNumber, parseGermanNumber } from '@/lib/format';

interface Props {
  schema: FormSchema;
  data: ResponseData;
  evaluation: FormEvaluation;
  readOnly?: boolean;
  showRequired?: boolean;
  onChange?: (key: string, v: AnswerValue | null) => void;
  onInstances?: (groupId: string, ids: string[]) => void;
  sectionFilter?: (sectionId: string) => boolean;
}

function codesFor(item: FormItem) {
  return item.type === 'yesno' ? [...YESNO_CODES] : item.codes ?? [];
}

function issuesFor(ev: FormEvaluation, key: string, showRequired: boolean): Issue[] {
  return ev.issues.filter((i) => i.key === key && (showRequired || i.kind !== 'pflicht'));
}

function NumberInput({ id, value, onCommit, readOnly, invalid, describedBy, decimals }: { id: string; value: number | undefined; onCommit: (n: number | null) => void; readOnly?: boolean; invalid: boolean; describedBy: string; decimals?: number }) {
  const [text, setText] = useState(value === undefined ? '' : fmtNumber(value, 6).replace(/\./g, ''));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText((t) => {
      const parsed = parseGermanNumber(t);
      if (value === undefined) return parsed === null || Number.isNaN(parsed) ? t : '';
      return parsed === value ? t : String(value).replace('.', ',');
    });
  }, [value]);
  return (
    <>
      <input
        id={id}
        type="text"
        inputMode={decimals === 0 ? 'numeric' : 'decimal'}
        value={text}
        readOnly={readOnly}
        aria-invalid={invalid || bad}
        aria-describedby={describedBy}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseGermanNumber(e.target.value);
          if (n === null) {
            setBad(false);
            onCommit(null);
          } else if (Number.isNaN(n)) setBad(true);
          else {
            setBad(false);
            onCommit(n);
          }
        }}
      />
      {bad && <div className="field-error" role="alert">Bitte eine gültige Zahl eingeben (z. B. 4,5).</div>}
    </>
  );
}

function ItemField({ item, k, a, ev, readOnly, showRequired, onChange }: { item: FormItem; k: string; a: AnswerValue | undefined; ev: FormEvaluation; readOnly?: boolean; showRequired: boolean; onChange?: (key: string, v: AnswerValue | null) => void }) {
  const uid = useId();
  const id = `f-${uid}`;
  const errs = issuesFor(ev, k, showRequired);
  const errorList = errs.filter((e) => e.severity === 'fehler');
  const hints = errs.filter((e) => e.severity === 'hinweis');
  const describedBy = `${id}-help ${id}-err`;
  const set = (v: AnswerValue | null) => onChange?.(k, v);
  const missing = a?.missing ?? null;
  const unit = [item.unit, item.method ? `Methode: ${item.method}` : null].filter(Boolean).join(' · ');
  const labelText = (
    <>
      {item.label}
      {item.required && <span className="muted small"> (Pflicht)</span>}
      {unit && <span className="muted small" style={{ fontWeight: 400 }}> – {unit}</span>}
    </>
  );

  if (item.type === 'computed') {
    const s = ev.scores.find((x) => x.key === k);
    return (
      <div className="field">
        <div style={{ fontWeight: 600 }}>{item.label}</div>
        <div aria-live="polite">{s?.value !== null && s?.value !== undefined ? <strong>{fmtNumber(s.value, 1)} {item.unit ?? 'Punkte'}</strong> : <span className="muted">{s?.reason ?? 'Noch nicht berechenbar'}</span>}</div>
        <div className="help">Berechnet, nur lesend ({item.compute?.algorithm}). {s ? `${s.usedInputs} von ${s.totalInputs} Angaben verwendet.` : ''}</div>
      </div>
    );
  }

  let control: React.ReactNode;
  const val = a?.value;
  const disabled = readOnly || !!missing;
  if (item.type === 'single' || item.type === 'yesno') {
    const codes = codesFor(item);
    control = (
      <fieldset aria-describedby={describedBy} aria-invalid={errorList.length > 0} style={{ margin: 0 }}>
        <legend>{labelText}</legend>
        <div className={codes.length <= 3 ? 'choice-row' : undefined}>
          {codes.map((c) => (
            <label key={c.code} className="choice">
              <input type="radio" name={`${id}-r`} value={c.code} checked={val === c.code} disabled={disabled} onChange={() => set({ value: c.code })} />
              {c.label}
            </label>
          ))}
        </div>
        {!readOnly && val !== undefined && val !== null && !missing && !item.required && (
          <button type="button" className="btn-ghost btn-small" onClick={() => set(null)}>Auswahl entfernen</button>
        )}
      </fieldset>
    );
  } else if (item.type === 'multi') {
    const arr = Array.isArray(val) ? val : [];
    control = (
      <fieldset aria-describedby={describedBy} style={{ margin: 0 }}>
        <legend>{labelText} <span className="muted small">(Mehrfachauswahl)</span></legend>
        {(item.codes ?? []).map((c) => (
          <label key={c.code} className="choice">
            <input type="checkbox" checked={arr.includes(c.code)} disabled={disabled} onChange={(e) => set({ value: e.target.checked ? [...arr, c.code] : arr.filter((x) => x !== c.code) })} />
            {c.label}
          </label>
        ))}
      </fieldset>
    );
  } else {
    let input: React.ReactNode;
    if (item.type === 'number') input = <NumberInput id={id} value={typeof val === 'number' ? val : undefined} readOnly={disabled} invalid={errorList.length > 0} describedBy={describedBy} decimals={item.decimals} onCommit={(n) => set(n === null ? null : { value: n })} />;
    else if (item.type === 'date') input = <input id={id} type="date" value={typeof val === 'string' ? val : ''} readOnly={disabled} aria-invalid={errorList.length > 0} aria-describedby={describedBy} onChange={(e) => set(e.target.value ? { value: e.target.value } : null)} />;
    else input = <textarea id={id} value={typeof val === 'string' ? val : ''} readOnly={disabled} rows={2} aria-invalid={errorList.length > 0} aria-describedby={describedBy} onChange={(e) => set(e.target.value ? { value: e.target.value } : null)} />;
    control = (
      <>
        <label htmlFor={id}>{labelText}</label>
        {input}
      </>
    );
  }

  return (
    <div className="field">
      {control}
      <div id={`${id}-help`} className="help">{item.help}</div>
      {(item.allowedMissing?.length ?? 0) > 0 && !readOnly && (
        <div className="row small" style={{ marginTop: 4 }}>
          <label htmlFor={`${id}-m`} style={{ fontWeight: 400, margin: 0 }}>Angabe nicht möglich:</label>
          <select id={`${id}-m`} style={{ width: 'auto', minHeight: 36 }} value={missing ?? ''} onChange={(e) => set(e.target.value ? { missing: e.target.value as MissingCode } : null)}>
            <option value="">– Wert angeben –</option>
            {item.allowedMissing!.map((m) => <option key={m} value={m}>{MISSING_CODES[m]}</option>)}
          </select>
        </div>
      )}
      {readOnly && missing && <div className="help">Fehlgrund: {MISSING_CODES[missing as MissingCode] ?? missing}</div>}
      <div id={`${id}-err`}>
        {errorList.map((e, i) => <div key={i} className="field-error">{e.message}</div>)}
        {hints.map((e, i) => <div key={i} className="field-hint">Hinweis: {e.message}</div>)}
      </div>
    </div>
  );
}

export function FormRenderer({ schema, data, evaluation, readOnly, showRequired = false, onChange, onInstances, sectionFilter }: Props) {
  const visible = new Set(evaluation.visibleKeys);
  return (
    <div>
      {schema.sections.filter((s) => evaluation.visibleSections.includes(s.id) && (!sectionFilter || sectionFilter(s.id))).map((s) => (
        <section key={s.id} className="card" aria-labelledby={`sec-${s.id}`}>
          <h2 id={`sec-${s.id}`}>{s.title}</h2>
          {s.items.map((item) => {
            if (item.type === 'group') {
              const ids = data.instances[item.id] ?? [];
              const groupIssues = issuesFor(evaluation, item.id, showRequired);
              return (
                <fieldset key={item.id}>
                  <legend>{item.label} ({ids.length} {item.repeat?.instanceLabel ?? 'Einträge'})</legend>
                  {ids.map((iid, n) => (
                    <div key={iid} className="group-instance">
                      <div className="row between">
                        <h3 style={{ margin: 0 }}>{item.repeat?.instanceLabel ?? 'Eintrag'} {n + 1}</h3>
                        {!readOnly && <button type="button" className="btn-ghost btn-small" onClick={() => onInstances?.(item.id, ids.filter((x) => x !== iid))}>{item.repeat?.instanceLabel ?? 'Eintrag'} {n + 1} entfernen</button>}
                      </div>
                      {(item.items ?? []).map((child) => {
                        const k = answerKey(child.id, item.id, iid);
                        return visible.has(k) ? <ItemField key={k} item={child} k={k} a={data.answers[k]} ev={evaluation} readOnly={readOnly} showRequired={showRequired} onChange={onChange} /> : null;
                      })}
                    </div>
                  ))}
                  {groupIssues.map((e, i) => <div key={i} className="field-error">{e.message}</div>)}
                  {!readOnly && ids.length < (item.repeat?.max ?? 10) && (
                    <button type="button" className="btn-secondary btn-small" onClick={() => onInstances?.(item.id, [...ids, crypto.randomUUID()])}>{item.repeat?.instanceLabel ?? 'Eintrag'} hinzufügen</button>
                  )}
                </fieldset>
              );
            }
            return visible.has(item.id) ? <ItemField key={item.id} item={item} k={item.id} a={data.answers[item.id]} ev={evaluation} readOnly={readOnly} showRequired={showRequired} onChange={onChange} /> : null;
          })}
        </section>
      ))}
      {evaluation.inactiveKeys.length > 0 && (
        <p className="small muted">{evaluation.inactiveKeys.length} ausgeblendete Angabe(n) bleiben historisch gespeichert, sind aktuell aber inaktiv und gehen nicht in Pflichtprüfungen oder Scores ein.</p>
      )}
    </div>
  );
}
