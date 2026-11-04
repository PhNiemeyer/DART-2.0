'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ItemDiff, SchemaDiff } from '@dart/forms';
import { api, ApiErr } from '@/lib/api';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

const ST: Record<string, string> = { entwurf: 'Entwurf', in_pruefung: 'In Prüfung', freigegeben: 'Freigegeben', veroeffentlicht: 'Veröffentlicht', ruhestand: 'Ruhestand' };
const ART: Record<ItemDiff['art'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  neu: { label: 'Neu', tone: 'ok' },
  entfernt: { label: 'Entfernt', tone: 'bad' },
  geaendert: { label: 'Geändert', tone: 'info' },
  verschoben: { label: 'Verschoben', tone: 'neutral' },
};
const SEC: Record<string, string> = { neu: 'Neuer Abschnitt', entfernt: 'Abschnitt entfernt', umbenannt: 'Abschnitt umbenannt', regel: 'Sichtbarkeit des Abschnitts geändert' };

interface DiffResponse {
  ziel: { id: string; version: number; status: string };
  basis: { id: string; version: number; status: string } | null;
  versionen: Array<{ id: string; version: number; status: string }>;
  diff: SchemaDiff | null;
}

export default function Vergleich() {
  const { vid } = useParams<{ vid: string }>();
  const [gegen, setGegen] = useState<string>('');
  const [r, setR] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [nurKritisch, setNurKritisch] = useState(false);

  useEffect(() => {
    setR(null);
    api(`/form-versions/${vid}/diff${gegen ? `?gegen=${gegen}` : ''}`).then(setR).catch(setError);
  }, [vid, gegen]);

  const felder = r?.diff?.felder.filter((f) => !nurKritisch || f.schwere === 'kritisch') ?? [];
  return (
    <>
      <p className="small no-print"><Link href={`/formulare/${vid}`}>← Zurück zum Editor</Link></p>
      <h1>Versionsvergleich</h1>
      <ConceptNote />
      <ErrorBox error={error} />
      {!r && !error && <Loading what="Vergleich" />}
      {r && (
        <>
          <section className="card no-print" aria-label="Vergleichsauswahl">
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="basis">Ausgangsversion</label>
                <select id="basis" value={gegen || r.basis?.id || ''} onChange={(e) => setGegen(e.target.value)}>
                  {r.versionen.filter((x) => x.id !== r.ziel.id).map((x) => <option key={x.id} value={x.id}>Version {x.version} ({ST[x.status] ?? x.status})</option>)}
                </select>
              </div>
              <div className="field">
                <span className="small muted">Vergleichsversion</span>
                <p style={{ margin: '6px 0 0' }}>Version {r.ziel.version} ({ST[r.ziel.status] ?? r.ziel.status})</p>
              </div>
            </div>
            <label className="choice"><input type="checkbox" checked={nurKritisch} onChange={(e) => setNurKritisch(e.target.checked)} />Nur kritische Änderungen anzeigen</label>
          </section>
          {!r.diff && <Alert kind="info" title="Keine Vorgängerversion">Dies ist die erste Version dieses Formulars.</Alert>}
          {r.diff?.identisch && <Alert kind="success" title="Keine inhaltlichen Unterschiede">Beide Versionen haben identische Abschnitte und Felder.</Alert>}
          {r.diff && !r.diff.identisch && (
            <>
              <section className="grid grid-3" aria-label="Zusammenfassung" style={{ marginBottom: 16 }}>
                <div className="kpi"><div className="num">{r.diff.anzahl.kritisch}</div><div>kritische Änderungen</div></div>
                <div className="kpi"><div className="num">{r.diff.anzahl.geaendert}</div><div>geänderte Felder</div></div>
                <div className="kpi"><div className="num">{r.diff.anzahl.neu} / {r.diff.anzahl.entfernt}</div><div>neue / entfernte Felder</div></div>
              </section>
              {r.diff.anzahl.kritisch > 0 && (
                <Alert kind="warning" title="Kritische Änderungen">
                  Diese Änderungen betreffen die Vergleichbarkeit über Versionen (Datentyp, Variablenkennung, entfernte Codes oder Felder, engere Grenzen, neue Pflichtfelder, Berechnung). Vor der Freigabe Auswirkungen auf Auswertungen und laufende Erhebungen prüfen.
                </Alert>
              )}
              {r.diff.abschnitte.length > 0 && (
                <section className="card" aria-labelledby="h-abs">
                  <h2 id="h-abs">Abschnitte</h2>
                  <ul>{r.diff.abschnitte.map((a, i) => <li key={i}>{SEC[a.art]}: {a.vorher ? `„${a.vorher}“` : ''}{a.vorher && a.nachher ? ' → ' : ''}{a.nachher ? `„${a.nachher}“` : ''} <span className="small muted">({a.sectionId})</span></li>)}</ul>
                </section>
              )}
              <section className="card" aria-labelledby="h-felder">
                <h2 id="h-felder">Felder ({felder.length})</h2>
                {felder.length === 0 && <p className="muted">Keine Einträge für diesen Filter.</p>}
                <div className="stack" style={{ gap: 12 }}>
                  {felder.map((f) => (
                    <article key={f.itemId} className="diff-item" aria-labelledby={`d-${f.itemId}`}>
                      <div className="row" style={{ gap: 8 }}>
                        <Badge tone={ART[f.art].tone}>{ART[f.art].label}</Badge>
                        {f.schwere === 'kritisch' && <Badge tone="bad">Kritisch</Badge>}
                        <h3 id={`d-${f.itemId}`} style={{ margin: 0, fontSize: '1rem' }}>{f.label}</h3>
                        <span className="small muted">{f.itemId} · {f.ort}</span>
                      </div>
                      {f.aenderungen.length > 0 && (
                        <div className="table-wrap" style={{ marginTop: 8 }}>
                          <table className="diff-table">
                            <colgroup><col style={{ width: '16%' }} /><col style={{ width: '30%' }} /><col style={{ width: '30%' }} /><col style={{ width: '24%' }} /></colgroup>
                            <thead><tr><th>Eigenschaft</th><th>Vorher (V{r.basis?.version})</th><th>Nachher (V{r.ziel.version})</th><th>Bewertung</th></tr></thead>
                            <tbody>
                              {f.aenderungen.map((c, i) => (
                                <tr key={i}>
                                  <td>{c.feld}</td>
                                  <td className="diff-old">{c.vorher}</td>
                                  <td className="diff-new">{c.nachher}</td>
                                  <td>{c.schwere === 'kritisch' ? 'Kritisch' : 'Hinweis'}{c.grund ? ` – ${c.grund}` : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
