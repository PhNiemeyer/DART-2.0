'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { Badge } from '@/components/ui';

interface Summary {
  eintraege: number;
  freigegeben: number;
  sha: string | null;
  nachKlasse: Array<{ klasse: string; n: number }>;
  nachBlatt: Array<{ sheet: string; n: number; a: number; b: number; c: number }>;
  hinweise: Array<{ hinweis: string; n: number }>;
  basicScience: Array<{ basic_science: string; n: number }>;
  entscheidungen: Array<{ entscheidung: string; n: number }>;
  neuanlage: Array<{ position: number; zielstruktur: string; details: Record<string, string> }>;
}

const KLASSE_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = { Übernahme: 'ok', Überarbeitung: 'warn', Entfall: 'neutral' };

/** Variablenkatalog Knie V05 aus den Originalquellen Q02/Q03 – Vorschläge, keine Freigaben. */
export function Catalog({ onError }: { onError: (e: ApiErr) => void }) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [f, setF] = useState({ sheet: '', klasse: '', hinweis: '', q: '', page: 1 });
  const [list, setList] = useState<{ total: number; items: any[] } | null>(null);
  const [showNeu, setShowNeu] = useState(false);

  useEffect(() => {
    api<Summary>('/migration/catalog/summary').then(setSum).catch(onError);
  }, [onError]);
  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)]));
    api(`/migration/catalog?${qs}`).then(setList).catch(onError);
  }, [f, onError]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  if (!sum) return null;
  if (sum.eintraege === 0) return <section className="card"><h2>Variablenkatalog Knie V05</h2><p className="muted">Der Katalog ist nicht geladen (Seed ausführen).</p></section>;
  const pages = list ? Math.max(1, Math.ceil(list.total / 50)) : 1;
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, page: 1, ...p }));

  return (
    <section className="card" aria-labelledby="h-kat">
      <h2 id="h-kat">Variablenkatalog Knie V05 (Originalquellen)</h2>
      <p className="small muted">
        Aus DART_2_Variablenklassifikation.xlsx und PROD_DatabaseDescriptionPlan_DART_Knie_V05.xlsx (SHA-256 geprüft). {sum.eintraege} Katalogzeilen – keine Anzahl eindeutiger medizinischer Konzepte.
        Alle Entscheidungen sind Vorschläge; eingetragene Freigaben: <strong>{sum.freigegeben}</strong>.
      </p>
      <div className="grid grid-3">
        {sum.nachKlasse.map((k) => <div key={k.klasse} className="kpi"><div className="num">{k.n}</div>{k.klasse}</div>)}
      </div>
      <h3 style={{ marginTop: 16 }}>Prüfhinweise (überlagern sich, nicht addierbar)</h3>
      <div className="row">
        {sum.hinweise.map((h) => (
          <button key={h.hinweis} type="button" className="chip" aria-pressed={f.hinweis === h.hinweis} style={f.hinweis === h.hinweis ? { background: 'var(--mint)', borderColor: 'var(--teal)' } : undefined} onClick={() => set({ hinweis: f.hinweis === h.hinweis ? '' : h.hinweis })}>
            {h.hinweis} ({h.n})
          </button>
        ))}
      </div>
      <form className="grid grid-3" style={{ marginTop: 12 }} onSubmit={(e) => e.preventDefault()}>
        <div className="field"><label htmlFor="ks">Blatt</label><select id="ks" value={f.sheet} onChange={(e) => set({ sheet: e.target.value })}><option value="">Alle</option>{sum.nachBlatt.map((b) => <option key={b.sheet} value={b.sheet}>{b.sheet} ({b.n})</option>)}</select></div>
        <div className="field"><label htmlFor="kk">Klasse</label><select id="kk" value={f.klasse} onChange={(e) => set({ klasse: e.target.value })}><option value="">Alle</option><option value="A">A Übernahme</option><option value="B">B Überarbeitung</option><option value="C">C Entfall (nur historisch)</option></select></div>
        <div className="field"><label htmlFor="kq">Suche (Name, Alias, VARID, Bezeichnung)</label><input id="kq" type="search" value={f.q} onChange={(e) => set({ q: e.target.value })} /></div>
      </form>
      {list && (
        <>
          <p className="small muted" aria-live="polite">{list.total} Einträge · Seite {f.page} von {pages}</p>
          <div className="table-wrap">
            <table className="data cards">
              <thead><tr><th className="nowrap">Blatt:Zeile</th><th>Altname / Alias</th><th className="nowrap">VARID</th><th>Bezeichnung</th><th>Klasse</th><th>Prüfhinweise</th></tr></thead>
              <tbody>
                {list.items.map((e) => (
                  <tr key={`${e.sheet}-${e.source_row}`}>
                    <td data-label="Blatt:Zeile" className="nowrap">{e.sheet}:{e.source_row}</td>
                    <td data-label="Altname / Alias"><code>{e.alt_name}</code>{e.sas_alias && e.sas_alias !== e.alt_name ? <div className="small muted">SAS: <code>{e.sas_alias}</code></div> : null}</td>
                    <td data-label="VARID" className="nowrap">{e.var_id ?? <span className="muted">fehlt</span>}</td>
                    <td data-label="Bezeichnung" className="small">{e.label}{e.codeliste ? <div className="muted">Codes: {e.codeliste.replace(/\n/g, '; ')}</div> : null}</td>
                    <td data-label="Klasse"><Badge tone={KLASSE_TONE[e.klasse] ?? 'neutral'}>{e.klasse}</Badge><div className="small muted">{e.entscheidung}</div></td>
                    <td data-label="Prüfhinweise" className="small">{e.pruefhinweise.join('; ') || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="row" aria-label="Seiten Katalog" style={{ marginTop: 8 }}>
            <button className="btn-ghost btn-small" disabled={f.page <= 1} onClick={() => setF((x) => ({ ...x, page: x.page - 1 }))}>Zurück</button>
            <button className="btn-ghost btn-small" disabled={f.page >= pages} onClick={() => setF((x) => ({ ...x, page: x.page + 1 }))}>Weiter</button>
          </nav>
        </>
      )}
      <details style={{ marginTop: 12 }} open={showNeu} onToggle={(e) => setShowNeu((e.target as HTMLDetailsElement).open)}>
        <summary>{sum.neuanlage.length} Neuanlage-Vorschläge (technische Felder, keine medizinischen Fragen)</summary>
        <ul className="small">{sum.neuanlage.map((n) => <li key={n.position}><code>{n.zielstruktur}</code> – {n.details['Zweck']} <span className="muted">({n.details['Entscheidung']})</span></li>)}</ul>
      </details>
    </section>
  );
}
