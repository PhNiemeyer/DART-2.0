'use client';
import { useEffect, useId, useState } from 'react';
import { formatGermanDate, parseGermanDate } from '@dart/forms';

interface Props {
  id?: string;
  /** ISO-Datum (JJJJ-MM-TT) oder leer */
  value: string;
  /** liefert ISO-Datum oder '' (leer bzw. noch unvollständig) */
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  readOnly?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  style?: React.CSSProperties;
}

/**
 * Datumseingabe TT.MM.JJJJ unabhängig von der Browsersprache (Restliste R-20).
 * Tastaturbedienbar, ohne Kalender-Popup; Fehler werden feldnah und für Screenreader angekündigt.
 */
export function DateInput({ id, value, onChange, min, max, readOnly, style, ...aria }: Props) {
  const auto = useId();
  const inputId = id ?? `d-${auto}`;
  const [text, setText] = useState(formatGermanDate(value));
  const [error, setError] = useState<string | null>(null);

  // Externe Änderungen übernehmen, ohne eine laufende Eingabe zu überschreiben
  useEffect(() => {
    setText((t) => {
      const p = parseGermanDate(t);
      if (p === value || (p === null && value === '')) return t;
      return formatGermanDate(value);
    });
  }, [value]);

  function validate(t: string): string | null {
    const p = parseGermanDate(t);
    if (p === null) return 'Bitte ein gültiges Datum im Format TT.MM.JJJJ eingeben.';
    if (p && min && p < min) return `Das Datum darf nicht vor dem ${formatGermanDate(min)} liegen.`;
    if (p && max && p > max) return `Das Datum darf nicht nach dem ${formatGermanDate(max)} liegen.`;
    return null;
  }

  const errId = `${inputId}-fehler`;
  const describedBy = [aria['aria-describedby'], `${inputId}-format`, error ? errId : null].filter(Boolean).join(' ');
  return (
    <>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="TT.MM.JJJJ"
        maxLength={10}
        value={text}
        readOnly={readOnly}
        style={style}
        aria-invalid={aria['aria-invalid'] || !!error}
        aria-describedby={describedBy}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const p = parseGermanDate(t);
          const err = p === null ? null : validate(t);
          if (p !== null && !err) {
            setError(null);
            onChange(p);
          } else if (p === '') {
            setError(null);
            onChange('');
          }
          if (err) setError(err);
        }}
        onBlur={() => {
          const err = validate(text);
          setError(err);
          const p = parseGermanDate(text);
          if (p) setText(formatGermanDate(p));
          if (err) onChange('');
        }}
      />
      <span id={`${inputId}-format`} className="sr-only">Format TT.MM.JJJJ</span>
      {error && <div id={errId} className="field-error" role="alert">{error}</div>}
    </>
  );
}
