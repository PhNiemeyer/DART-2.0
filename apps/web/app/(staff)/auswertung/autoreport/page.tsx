'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toCsv } from '@dart/domain';
import { api, ApiErr } from '@/lib/api';
import { fmtDate, fmtNumber } from '@/lib/format';
import { useMe } from '@/lib/session';
import { DateInput } from '@/components/DateInput';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

// Validierte Farbpaarung (dataviz-Validator: alle Prüfungen bestanden); zusätzlich Form (Kreis/Raute) und Legende.
const C_OWN = '#1559B7';
const C_TOTAL = '#C2671E';

interface Stat { n: number; mean: number | null; sd: number | null }
interface Cmp { diff: number | null; ciLow: number | null; ciHigh: number | null; einordnung: 'ueber' | 'unter' | 'im_bereich' | 'zu_wenige_faelle' }
interface Line { gruppe: string; label: string; eigen: Stat; zentrum: Stat | null; gesamt: Stat; vergleich: Cmp }
interface Cell { n: number | null; klein?: boolean; anteil: number | null; mittelwert: number | null }
interface Report {
  stichtag: string;
  ebenen: { eigen: string; zentrum: string | null; gesamt: string };
  score: { ref: string; name: string; status: string; quelle: string | null; richtung: string; bereich: [number, number]; einheit: string };
  merkmale: Array<{ merkmal: string; auspraegung: string; eigen: Cell | null; zentrum: Cell | null; gesamt: Cell | null }>;
  alleFaelle: Line;
  outcome: Line[];
  verlauf: Array<{ timepoint: string; eigen: Stat; gesamt: Stat; vergleich: Cmp }>;
  hinweise: string[];
}

const SCORES: Array<[string, string]> = [
  ['IKDC@1', 'IKDC Subjective Knee Form'],
  ['KOOS-SCHMERZ@1', 'KOOS Schmerz'],
  ['KOOS-SYMPTOME@1', 'KOOS Symptome'],
  ['KOOS-ADL@1', 'KOOS Alltagsaktivitäten'],
  ['KOOS-SPORT@1', 'KOOS Sport/Freizeit'],
  ['KOOS-QOL@1', 'KOOS Lebensqualität'],
  ['DEMO-SCORE@1', 'Demonstrationsscore'],
];
const TP: Record<string, string> = { BL: 'Baseline', M6: '6 Monate', M12: '12 Monate', M24: '24 Monate', M36: '36 Monate', M60: '60 Monate' };
const MERKMAL: Record<string, string> = { altersgruppe: 'Altersgruppe bei Behandlung', geschlecht: 'Geschlecht', seite: 'Seite', behandlung: 'Behandlungsart', modus: 'Erfassungsmodus', bmi: 'BMI (Baseline, kg/m²)', voroperation: 'Voroperationen am Knie', sport: 'Sportlich aktiv (Baseline)' };
const AUSPR: Record<string, string> = { weiblich: 'weiblich', maennlich: 'männlich', divers: 'divers', unbekannt: 'unbekannt', 'nicht erfasst': 'nicht erfasst', links: 'links', rechts: 'rechts', operativ: 'operativ', konservativ: 'konservativ', basic: 'DART Basic', science: 'DART Science', ja: 'ja', nein: 'nein' };
const EINORDNUNG: Record<Cmp['einordnung'], [string, 'ok' | 'warn' | 'neutral' | 'info']> = {
  ueber: ['über Gesamtkollektiv', 'info'],
  unter: ['unter Gesamtkollektiv', 'warn'],
  im_bereich: ['im Bereich', 'neutral'],
  zu_wenige_faelle: ['zu wenige Fälle', 'neutral'],
};

const f1 = (x: number | null | undefined) => (x === null || x === undefined ? '–' : fmtNumber(x, 1));
const ci = (s: Stat) => (s.mean === null || s.sd === null || s.n < 2 ? null : 1.96 * (s.sd / Math.sqrt(s.n)));

/** Punkt-Intervall-Diagramm: eigener Mittelwert mit 95-%-KI (Kreis) gegen Gesamtkollektiv (Raute) je Gruppe. */
function ForestPlot({ rows, range, unit, ownLabel }: { rows: Line[]; range: [number, number]; unit: string; ownLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const L = 210;
  const R = 24;
  const rowH = 34;
  const H = rows.length * rowH + 40;
  const vals = rows.flatMap((r) => [r.gesamt.mean, r.vergleich.ciLow, r.vergleich.ciHigh, r.eigen.mean]).filter((v): v is number => v !== null);
  const lo = vals.length ? Math.max(range[0], Math.floor((Math.min(...vals) - 5) / 10) * 10) : range[0];
  const hi = vals.length ? Math.min(range[1], Math.ceil((Math.max(...vals) + 5) / 10) * 10) : range[1];
  const x = (v: number) => L + ((v - lo) / (hi - lo || 1)) * (W - L - R);
  const ticks = Array.from({ length: Math.floor((hi - lo) / 10) + 1 }, (_, i) => lo + i * 10);
  return (
    <figure style={{ margin: 0 }}>
      <div className="row small" style={{ marginBottom: 6 }} aria-hidden="true">
        <span className="row" style={{ gap: 6 }}><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill={C_OWN} /></svg>{ownLabel} (Mittelwert, 95-%-KI)</span>
        <span className="row" style={{ gap: 6 }}><svg width="14" height="14"><rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" fill={C_TOTAL} /></svg>Gesamtkollektiv (Mittelwert)</span>
      </div>
      <div className="table-wrap" style={{ position: 'relative', overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Mittelwerte je Gruppe, ${ownLabel} gegenüber Gesamtkollektiv; Tabelle unten`} style={{ minWidth: 520, display: 'block' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={8} y2={H - 26} stroke="var(--border)" strokeWidth={1} />
              <text x={x(t)} y={H - 10} fontSize={12} textAnchor="middle" fill="var(--muted)">{t}</text>
            </g>
          ))}
          <text x={L - 12} y={H - 10} fontSize={11} textAnchor="end" fill="var(--muted)">{unit}</text>
          {rows.map((r, i) => {
            const y = 20 + i * rowH;
            const own = r.eigen.mean;
            return (
              <g key={r.gruppe} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={0} y={y - rowH / 2} width={W} height={rowH} fill={hover === i ? 'var(--background)' : 'transparent'} />
                <text x={L - 12} y={y + 4} fontSize={13} textAnchor="end" fill="var(--text)">{r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label}</text>
                {r.vergleich.ciLow !== null && r.vergleich.ciHigh !== null && <line x1={x(r.vergleich.ciLow)} x2={x(r.vergleich.ciHigh)} y1={y} y2={y} stroke={C_OWN} strokeWidth={2} strokeLinecap="round" />}
                {r.gesamt.mean !== null && <rect x={x(r.gesamt.mean) - 5} y={y - 5} width={10} height={10} transform={`rotate(45 ${x(r.gesamt.mean)} ${y})`} fill={C_TOTAL} stroke="var(--surface)" strokeWidth={2} />}
                {own !== null && <circle cx={x(own)} cy={y} r={6} fill={C_OWN} stroke="var(--surface)" strokeWidth={2} />}
                {own === null && <text x={L + 8} y={y + 4} fontSize={12} fill="var(--muted)">{r.eigen.n > 0 ? `n = ${r.eigen.n} – zu wenige Fälle` : 'keine eigenen Fälle'}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div role="status" className="small" style={{ position: 'absolute', left: 8, top: 20 + hover * rowH + 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', boxShadow: '0 2px 8px rgba(18,48,74,.12)', pointerEvents: 'none' }}>
            <strong>{rows[hover].label}</strong><br />
            Eigen: n = {rows[hover].eigen.n}, MW {f1(rows[hover].eigen.mean)}{rows[hover].vergleich.ciLow !== null ? ` (KI ${f1(rows[hover].vergleich.ciLow)}–${f1(rows[hover].vergleich.ciHigh)})` : ''}<br />
            Gesamt: n = {rows[hover].gesamt.n}, MW {f1(rows[hover].gesamt.mean)} · Δ {f1(rows[hover].vergleich.diff)}
          </div>
        )}
      </div>
    </figure>
  );
}

/** Verlauf über die Zeitpunkte: zwei Linien (eigen durchgezogen, gesamt gestrichelt). */
function TrendChart({ points, range, ownLabel }: { points: Report['verlauf']; range: [number, number]; ownLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const L = 44;
  const B = 32;
  const T = 16;
  const x = (i: number) => L + (i * (W - L - 24)) / Math.max(1, points.length - 1);
  const vals = points.flatMap((p) => [p.eigen.mean, p.gesamt.mean]).filter((v): v is number => v !== null);
  const lo = vals.length ? Math.max(range[0], Math.floor((Math.min(...vals) - 10) / 10) * 10) : range[0];
  const hi = vals.length ? Math.min(range[1], Math.ceil((Math.max(...vals) + 10) / 10) * 10) : range[1];
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const path = (k: 'eigen' | 'gesamt') => points.map((p, i) => (p[k].mean === null ? null : `${x(i)},${y(p[k].mean!)}`)).filter(Boolean).join(' ');
  const ticks = Array.from({ length: Math.floor((hi - lo) / 10) + 1 }, (_, i) => lo + i * 10);
  return (
    <figure style={{ margin: 0, position: 'relative' }}>
      <div className="row small" style={{ marginBottom: 6 }} aria-hidden="true">
        <span className="row" style={{ gap: 6 }}><svg width="22" height="10"><line x1="1" x2="21" y1="5" y2="5" stroke={C_OWN} strokeWidth="2" /></svg>{ownLabel}</span>
        <span className="row" style={{ gap: 6 }}><svg width="22" height="10"><line x1="1" x2="21" y1="5" y2="5" stroke={C_TOTAL} strokeWidth="2" strokeDasharray="5 3" /></svg>Gesamtkollektiv</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Mittelwerte über die Zeitpunkte; Tabelle unten" style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 24} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} fontSize={12} textAnchor="end" fill="var(--muted)">{t}</text>
          </g>
        ))}
        {points.map((p, i) => <text key={p.timepoint} x={x(i)} y={H - 10} fontSize={12} textAnchor="middle" fill="var(--muted)">{TP[p.timepoint]}</text>)}
        <polyline points={path('gesamt')} fill="none" stroke={C_TOTAL} strokeWidth={2} strokeDasharray="6 4" />
        <polyline points={path('eigen')} fill="none" stroke={C_OWN} strokeWidth={2} />
        {points.map((p, i) => (
          <g key={p.timepoint}>
            {p.gesamt.mean !== null && <rect x={x(i) - 5} y={y(p.gesamt.mean) - 5} width={10} height={10} transform={`rotate(45 ${x(i)} ${y(p.gesamt.mean)})`} fill={C_TOTAL} stroke="var(--surface)" strokeWidth={2} />}
            {p.eigen.mean !== null && <circle cx={x(i)} cy={y(p.eigen.mean)} r={5} fill={C_OWN} stroke="var(--surface)" strokeWidth={2} />}
            <rect x={x(i) - 30} y={T} width={60} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 3" />}
      </svg>
      {hover !== null && (
        <div role="status" className="small" style={{ position: 'absolute', left: `${(x(hover) / W) * 100}%`, top: 24, transform: 'translateX(-50%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', boxShadow: '0 2px 8px rgba(18,48,74,.12)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <strong>{TP[points[hover].timepoint]}</strong><br />Eigen: {f1(points[hover].eigen.mean)} (n = {points[hover].eigen.n})<br />Gesamt: {f1(points[hover].gesamt.mean)} (n = {points[hover].gesamt.n})
        </div>
      )}
    </figure>
  );
}

function Einordnung({ c }: { c: Cmp }) {
  const [t, tone] = EINORDNUNG[c.einordnung];
  return <Badge tone={tone}>{c.einordnung === 'ueber' ? '▲ ' : c.einordnung === 'unter' ? '▼ ' : ''}{t}</Badge>;
}

const cellText = (c: Cell | null, numeric: boolean) => {
  if (!c) return '–';
  if (c.klein) return '< 5';
  if (numeric) return c.mittelwert === null ? '–' : `${f1(c.mittelwert)} (n = ${c.n})`;
  return `${c.n ?? 0}${c.anteil !== null ? ` (${fmtNumber(c.anteil, 1)} %)` : ''}`;
};

export default function AutoReport() {
  const me = useMe();
  const isSurgeon = me.roles.some((r) => r.role === 'arzt');
  const [f, setF] = useState({ ebene: isSurgeon ? 'operateur' : 'zentrum', score: 'IKDC@1', timepoint: 'M12', dimension: 'modul', delta: 'false', from: '', to: '' });
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      setRep(await api<Report>(`/reports/auto?${qs}`));
      setError(null);
    } catch (e) {
      setError(e as ApiErr);
    } finally {
      setLoading(false);
    }
  }, [f]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  function exportCsv() {
    if (!rep) return;
    const rows = [rep.alleFaelle, ...rep.outcome].map((o) => ({
      gruppe: o.label, eigen_n: o.eigen.n, eigen_mittelwert: o.eigen.mean, eigen_sd: o.eigen.sd, ki_unten: o.vergleich.ciLow, ki_oben: o.vergleich.ciHigh,
      zentrum_n: o.zentrum?.n ?? '', zentrum_mittelwert: o.zentrum?.mean ?? '', gesamt_n: o.gesamt.n, gesamt_mittelwert: o.gesamt.mean, differenz: o.vergleich.diff, einordnung: EINORDNUNG[o.vergleich.einordnung][0],
    }));
    const head = `# DART Autoreport · ${rep.score.name} · ${TP[f.timepoint]}${f.delta === 'true' ? ' (Veränderung zur Baseline)' : ''} · Stichtag ${fmtDate(rep.stichtag)} · nicht risikoadjustiert · synthetische Daten\r\n`;
    const csv = head + toCsv(Object.keys(rows[0]), rows);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `autoreport-${rep.score.ref.replace('@', '-')}-${f.timepoint}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const groupsByMerkmal = rep ? Object.entries(rep.merkmale.reduce<Record<string, Report['merkmale']>>((m, x) => ((m[x.merkmal] ??= []).push(x), m), {})) : [];
  const ownLabel = f.ebene === 'operateur' ? 'Eigene Fälle' : 'Eigenes Zentrum';

  return (
    <>
      <p className="small no-print"><Link href="/auswertung">← Auswertung &amp; Export</Link></p>
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>Autoreport mit Benchmarking</h1>
        <div className="row no-print">
          <button className="btn-ghost" onClick={exportCsv} disabled={!rep}>CSV exportieren</button>
          <button className="btn-secondary" onClick={() => window.print()} disabled={!rep}>Drucken / PDF</button>
        </div>
      </div>
      <ConceptNote />
      <section className="card no-print" aria-label="Berichtsparameter">
        <form className="grid grid-3" onSubmit={(e) => e.preventDefault()}>
          <div className="field"><label htmlFor="eb">Eigene Daten</label><select id="eb" value={f.ebene} onChange={(e) => set({ ebene: e.target.value })}>{isSurgeon && <option value="operateur">Eigene Fälle als Operateur/in</option>}<option value="zentrum">Eigenes Zentrum</option></select></div>
          <div className="field"><label htmlFor="sc">Outcome</label><select id="sc" value={f.score} onChange={(e) => set({ score: e.target.value })}>{SCORES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="tp">Zeitpunkt</label><select id="tp" value={f.timepoint} onChange={(e) => set({ timepoint: e.target.value })}>{Object.entries(TP).map(([v, l]) => <option key={v} value={v} disabled={f.delta === 'true' && v === 'BL'}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="dl">Darstellung</label><select id="dl" value={f.delta} onChange={(e) => set({ delta: e.target.value, timepoint: e.target.value === 'true' && f.timepoint === 'BL' ? 'M12' : f.timepoint })}><option value="false">Absoluter Wert zum Zeitpunkt</option><option value="true">Veränderung gegenüber Baseline</option></select></div>
          <div className="field"><label htmlFor="dm">Gruppierung (Diagnose/Pathologie)</label><select id="dm" value={f.dimension} onChange={(e) => set({ dimension: e.target.value })}><option value="modul">Pathologie/Modul</option><option value="eingriff">Eingriff (Konzept)</option><option value="modus">Erfassungsmodus</option><option value="behandlung">Behandlungsart</option></select></div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}><label htmlFor="rf">Bezugsdatum von</label><DateInput id="rf" value={f.from} onChange={(iso) => set({ from: iso })} /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="rt">bis</label><DateInput id="rt" value={f.to} onChange={(iso) => set({ to: iso })} /></div>
          </div>
        </form>
      </section>
      <ErrorBox error={error} onRetry={load} />
      {loading && !rep && <Loading what="Bericht" />}
      {rep && (
        <>
          <Alert kind="warning" title="Vorläufige, deskriptive Auswertung">
            <ul>{rep.hinweise.map((h) => <li key={h}>{h}</li>)}</ul>
          </Alert>
          <p className="small muted">
            {rep.score.name} · {rep.score.richtung} · Bereich {rep.score.bereich[0]}–{rep.score.bereich[1]} {rep.score.einheit}
            {rep.score.quelle ? ` · Quelle: ${rep.score.quelle}` : ''} · Stichtag {fmtDate(rep.stichtag)} · Vergleich: {rep.ebenen.eigen}{rep.ebenen.zentrum ? `, ${rep.ebenen.zentrum}` : ''} gegenüber {rep.ebenen.gesamt}
          </p>

          <section className="card" aria-labelledby="h-kurz">
            <h2 id="h-kurz">Zusammenfassung: {TP[f.timepoint]}{f.delta === 'true' ? ' – Veränderung zur Baseline' : ''}</h2>
            <div className="grid grid-3">
              <div className="kpi"><div className="num">{f1(rep.alleFaelle.eigen.mean)}</div>{rep.ebenen.eigen} (n = {rep.alleFaelle.eigen.n}){rep.alleFaelle.vergleich.ciLow !== null ? `, 95-%-KI ${f1(rep.alleFaelle.vergleich.ciLow)}–${f1(rep.alleFaelle.vergleich.ciHigh)}` : ''}</div>
              <div className="kpi"><div className="num" style={{ color: 'var(--text)' }}>{f1(rep.alleFaelle.gesamt.mean)}</div>Gesamtkollektiv (n = {rep.alleFaelle.gesamt.n})</div>
              <div className="kpi"><div className="num" style={{ color: 'var(--text)' }}>{rep.alleFaelle.vergleich.diff === null ? '–' : `${rep.alleFaelle.vergleich.diff > 0 ? '+' : ''}${f1(rep.alleFaelle.vergleich.diff)}`}</div>Abweichung · <Einordnung c={rep.alleFaelle.vergleich} /></div>
            </div>
          </section>

          <section className="card" aria-labelledby="h-out">
            <h2 id="h-out">Outcome nach {f.dimension === 'modul' ? 'Pathologie/Modul' : f.dimension === 'eingriff' ? 'Eingriff' : f.dimension === 'modus' ? 'Erfassungsmodus' : 'Behandlungsart'}</h2>
            {rep.outcome.length === 0 ? <p className="muted">Keine abgeschlossenen Erhebungen für diese Auswahl.</p> : <ForestPlot rows={rep.outcome} range={f.delta === 'true' ? [-100, 100] : rep.score.bereich} unit={rep.score.einheit} ownLabel={ownLabel} />}
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data cards">
                <caption className="sr-only">Outcome je Gruppe mit Abweichung vom Gesamtkollektiv</caption>
                <thead><tr><th>Gruppe</th><th>{ownLabel}: n · MW (95-%-KI)</th>{rep.ebenen.zentrum && <th>Zentrum: n · MW</th>}<th>Gesamt: n · MW</th><th>Abweichung</th><th>Einordnung</th></tr></thead>
                <tbody>
                  {[rep.alleFaelle, ...rep.outcome].map((o) => (
                    <tr key={o.gruppe} style={o.gruppe === 'GESAMT' ? { fontWeight: 600 } : undefined}>
                      <td data-label="Gruppe">{o.label}</td>
                      <td data-label={ownLabel}>{o.eigen.n} · {f1(o.eigen.mean)}{o.vergleich.ciLow !== null ? ` (${f1(o.vergleich.ciLow)}–${f1(o.vergleich.ciHigh)})` : ''}</td>
                      {rep.ebenen.zentrum && <td data-label="Zentrum">{o.zentrum ? `${o.zentrum.n} · ${f1(o.zentrum.mean)}` : '–'}</td>}
                      <td data-label="Gesamt">{o.gesamt.n} · {f1(o.gesamt.mean)}</td>
                      <td data-label="Abweichung">{o.vergleich.diff === null ? '–' : `${o.vergleich.diff > 0 ? '+' : ''}${f1(o.vergleich.diff)}`}</td>
                      <td data-label="Einordnung"><Einordnung c={o.vergleich} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="h-verl">
            <h2 id="h-verl">Verlauf über die Zeitpunkte (alle Fälle)</h2>
            <TrendChart points={rep.verlauf} range={f.delta === 'true' ? [-100, 100] : rep.score.bereich} ownLabel={ownLabel} />
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data cards">
                <thead><tr><th>Zeitpunkt</th><th>{ownLabel}: n · MW</th><th>Gesamt: n · MW</th><th>Abweichung</th><th>Einordnung</th></tr></thead>
                <tbody>{rep.verlauf.map((v) => <tr key={v.timepoint}><td data-label="Zeitpunkt">{TP[v.timepoint]}</td><td data-label={ownLabel}>{v.eigen.n} · {f1(v.eigen.mean)}</td><td data-label="Gesamt">{v.gesamt.n} · {f1(v.gesamt.mean)}</td><td data-label="Abweichung">{v.vergleich.diff === null ? '–' : `${v.vergleich.diff > 0 ? '+' : ''}${f1(v.vergleich.diff)}`}</td><td data-label="Einordnung"><Einordnung c={v.vergleich} /></td></tr>)}</tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="h-merk">
            <h2 id="h-merk">Patientencharakteristika</h2>
            <p className="small muted">Zählweise: Behandlungsfälle. Anteile bezogen auf Fälle mit erfasstem Merkmal; „unbekannt“/„nicht erfasst“ als Anteil aller Fälle (Datenvollständigkeit, ohne Abweichung). „&lt; 5“ = unterdrückte Kleingruppe.</p>
            <div className="table-wrap">
              <table className="data cards">
                <thead><tr><th>Merkmal</th><th>Ausprägung</th><th>{ownLabel}</th>{rep.ebenen.zentrum && <th>Zentrum</th>}<th>Gesamtkollektiv</th><th>Abweichung (Prozentpunkte)</th></tr></thead>
                <tbody>
                  {groupsByMerkmal.map(([m, rows]) =>
                    rows.map((r, i) => {
                      const numeric = m === 'bmi';
                      const dev = ['unbekannt', 'nicht erfasst'].includes(r.auspraegung) ? null : numeric ? (r.eigen?.mittelwert ?? null) !== null && (r.gesamt?.mittelwert ?? null) !== null ? r.eigen!.mittelwert! - r.gesamt!.mittelwert! : null : r.eigen?.anteil != null && r.gesamt?.anteil != null ? r.eigen.anteil - r.gesamt.anteil : null;
                      return (
                        <tr key={m + r.auspraegung}>
                          <td data-label="Merkmal">{i === 0 ? MERKMAL[m] ?? m : ''}</td>
                          <td data-label="Ausprägung">{AUSPR[r.auspraegung] ?? r.auspraegung}</td>
                          <td data-label={ownLabel}>{cellText(r.eigen, numeric)}</td>
                          {rep.ebenen.zentrum && <td data-label="Zentrum">{cellText(r.zentrum, numeric)}</td>}
                          <td data-label="Gesamtkollektiv">{cellText(r.gesamt, numeric)}</td>
                          <td data-label="Abweichung">{dev === null ? '–' : `${dev > 0 ? '+' : ''}${fmtNumber(Math.round(dev * 10) / 10, 1)}${numeric ? ' kg/m²' : ' pp'}`}</td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
