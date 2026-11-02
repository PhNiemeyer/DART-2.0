'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { SAMPLE_CSV } from '@/lib/sample-csv';
import { Alert, Badge, ConceptNote, ErrorBox } from '@/components/ui';

const OUT: Record<string, string> = { normalisiert: 'Normalisiert', archiviert: 'Bewusst historisch archiviert', ungeklaert: 'Gesichert, ungeklärt', quarantaene: 'Quarantäne' };

function Summary({ s }: { s: any }) {
  if (!s) return null;
  return (
    <div className="small">
      <p style={{ margin: '4px 0' }}><strong>Zeilenbilanz:</strong> geliefert {s.zeilen.geliefert} = normalisiert {s.zeilen.normalisiert} + archiviert {s.zeilen.archiviert} + ungeklärt {s.zeilen.ungeklaert} + Quarantäne {s.zeilen.quarantaene} → {s.zeilen.ausgeglichen ? <Badge tone="ok">ausgeglichen</Badge> : <Badge tone="bad">nicht ausgeglichen</Badge>}</p>
      <p style={{ margin: '4px 0' }}><strong>Wertebilanz:</strong> {s.werte.erfasst} von {s.werte.geliefert} Zellen erfasst ({s.werte.ausgeglichen ? 'vollständig' : 'unvollständig'}) · {Object.entries(s.werte.nachErgebnis).map(([k, v]) => `${OUT[k] ?? k}: ${v}`).join(' · ')}</p>
      <p style={{ margin: '4px 0' }}><strong>Vergleichbarkeit:</strong> {Object.entries(s.werte.vergleichbarkeit).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
      <p style={{ margin: '4px 0' }}><strong>Klärungsliste:</strong> {Object.entries(s.hinweise).map(([k, v]) => `${k} (${v})`).join(', ') || 'keine'}</p>
      <p style={{ margin: '4px 0' }}><strong>Nach Zeitpunkt (Codeliste, nicht numerisch):</strong> {Object.entries(s.nachZeitpunkt).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
      {s.import && <p style={{ margin: '4px 0' }}><strong>Import:</strong> neu {s.import.neu}, bereits vorhanden (idempotent übersprungen) {s.import.bereitsVorhanden}</p>}
    </div>
  );
}

export default function Migration() {
  const [csv, setCsv] = useState('');
  const [meta, setMeta] = useState({ fileName: 'altexport-synthetisch-CA.csv', sheet: 'CA', sourceSystem: 'DART-ALT-SYNTH', exportVersion: 'SYNTH-1' });
  const [result, setResult] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [manifest, setManifest] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setBatches((await api('/migration-batches')).items);
      setManifest((await api('/migration/manifest')).items);
    } catch (e) {
      setError(e as ApiErr);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = (kind: 'dry-run' | 'import') => api(`/migration-batches/${kind}`, { body: { ...meta, csv } }).then((r) => { setResult(r); setMsg(kind === 'import' ? 'Import abgeschlossen (stumm: keine Einladungen, keine Kontoaktivierung).' : 'Probelauf abgeschlossen – keine Zieldaten geschrieben.'); setError(null); return load(); }).catch(setError);
  return (
    <>
      <h1>Historische Migration</h1>
      <ConceptNote />
      <Alert kind="info">Prototyp mit synthetischer Quelle „DART-ALT-SYNTH“ und Mappingversion MAP-DART-ALT-SYNTH V1 (Vorschlag, keine bestätigten Mappingregeln). Rohwerte werden unverändert gesichert; nichts wird still repariert.</Alert>
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      <section className="card">
        <h2>Quellenmanifest</h2>
        <div className="table-wrap"><table className="data cards"><thead><tr><th>Quelle</th><th>Datei</th><th>Status</th><th>Hinweis</th></tr></thead>
          <tbody>{manifest.map((m) => <tr key={m.id}><td data-label="Quelle">{m.source_code}</td><td data-label="Datei">{m.file_name}{m.expected_sha256 && <div className="small muted">erwarteter SHA-256: {m.expected_sha256.slice(0, 16)}…</div>}</td><td data-label="Status"><Badge tone={m.status === 'vorhanden' ? 'ok' : 'warn'}>{m.status}</Badge></td><td data-label="Hinweis" className="small">{m.note}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section className="card">
        <h2>Batch ausführen</h2>
        <div className="grid grid-3">
          <div className="field"><label htmlFor="fn">Dateiname</label><input id="fn" type="text" value={meta.fileName} onChange={(e) => setMeta({ ...meta, fileName: e.target.value })} /></div>
          <div className="field"><label htmlFor="sh">Blatt</label><input id="sh" type="text" value={meta.sheet} onChange={(e) => setMeta({ ...meta, sheet: e.target.value.toUpperCase() })} /></div>
          <div className="field"><label htmlFor="ev">Exportversion</label><input id="ev" type="text" value={meta.exportVersion} onChange={(e) => setMeta({ ...meta, exportVersion: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="csv">CSV-Inhalt (Semikolon oder Komma)</label><textarea id="csv" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ fontFamily: 'monospace', fontSize: '.85rem' }} /></div>
        <div className="row">
          <button className="btn-ghost" onClick={() => setCsv(SAMPLE_CSV)}>Synthetische Beispieldatei laden</button>
          <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Datei wählen<input type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setMeta({ ...meta, fileName: f.name }); } }} /></label>
          <button className="btn-secondary" disabled={!csv} onClick={() => run('dry-run')}>Probelauf (Dry-run)</button>
          <button disabled={!csv} onClick={() => run('import')}>Importieren</button>
        </div>
        {result && <div className="alert alert-info" style={{ marginTop: 12 }}><strong>Ergebnis {result.mode === 'import' ? 'Import' : 'Probelauf'}</strong> · Datei-SHA-256 {result.fileSha256.slice(0, 16)}…<Summary s={result.summary} /></div>}
      </section>
      <section className="card">
        <h2>Batches</h2>
        {batches.length === 0 && <p className="muted">Noch keine Batches.</p>}
        {batches.map((b) => (
          <div key={b.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
            <div className="row between"><span><strong>{b.file_name}</strong> · {b.mode === 'import' ? 'Import' : 'Probelauf'} · {fmtDateTime(b.created_at)} · {b.records} Datensätze · Mapping {b.mapping_code} V{b.mapping_version}</span><Badge tone={b.status === 'importiert' ? 'ok' : b.status === 'zurueckgerollt' ? 'neutral' : 'info'}>{b.status}</Badge></div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn-ghost btn-small" onClick={() => api(`/migration-batches/${b.id}/report`).then(setReport).catch(setError)}>Reconciliation-Bericht</button>
              {b.status === 'importiert' && <button className="btn-danger btn-small" onClick={() => api(`/migration-batches/${b.id}/rollback`, { body: {} }).then((r) => { setMsg(`Zurückgerollt: ${r.entfernteDatensaetze} Datensätze entfernt.`); return load(); }).catch(setError)}>Rollback</button>}
            </div>
          </div>
        ))}
      </section>
      {report && (
        <section className="card">
          <h2>Reconciliation-Bericht</h2>
          <Summary s={report.batch.summary} />
          <p className="small"><strong>Rohwert-Nachweis:</strong> {report.rohwertNachweis.hashKorrekt} von {report.rohwertNachweis.geprueft} Datensätzen mit korrekter SHA-256 · verwaiste Werte: {report.verwaisteWerte}</p>
          <h3>Klärungsliste</h3>
          <ul className="small">{report.hinweise.map((h: any) => <li key={h.code}>{h.code} ({h.n}){h.blocking ? ' – blockierend' : ''}: {h.beispiel}</li>)}</ul>
          <h3>Variablenstatistik</h3>
          <div className="table-wrap"><table className="data cards"><thead><tr><th>Spalte</th><th>Werte</th><th>leer</th><th>normalisiert</th><th>ungeklärt</th><th>Min/Max (roh)</th></tr></thead>
            <tbody>{report.variablenStatistik.map((v: any) => <tr key={v.column_name}><td data-label="Spalte">{v.column_name}</td><td data-label="Werte">{v.n}</td><td data-label="leer">{v.leer}</td><td data-label="normalisiert">{v.normalisiert}</td><td data-label="ungeklärt">{v.ungeklaert}</td><td data-label="Min/Max">{v.min_roh ?? '–'} / {v.max_roh ?? '–'}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
