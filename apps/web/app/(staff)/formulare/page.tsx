'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiErr } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

const ST: Record<string, [string, 'ok' | 'warn' | 'info' | 'neutral' | 'bad']> = { entwurf: ['Entwurf', 'info'], in_pruefung: ['In Prüfung', 'warn'], freigegeben: ['Freigegeben', 'warn'], veroeffentlicht: ['Veröffentlicht', 'ok'], ruhestand: ['Ruhestand', 'neutral'] };

export default function Forms() {
  const me = useMe();
  const router = useRouter();
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [nf, setNf] = useState({ code: '', title: '', audience: 'arzt', module: 'BASIS' });
  const [importText, setImportText] = useState('');
  const load = useCallback(() => api('/questionnaires').then((r) => setItems(r.items)).catch(setError), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <h1>Formulare und Versionen</h1>
      <ConceptNote />
      <p className="small muted">Ablauf: Entwurf → Prüfung → Vier-Augen-Freigabe → Veröffentlichung → Ruhestand. Veröffentlichte Versionen sind unveränderlich; laufende Erhebungen behalten ihre Version. Alle Inhalte sind Beispiele ohne fachliche Freigabe.</p>
      <ErrorBox error={error} />
      {!items && !error && <Loading what="Formulare" />}
      {items && (
        <div className="table-wrap">
          <table className="data cards">
            <thead><tr><th>Formular</th><th>Zielgruppe / Modul</th><th>Versionen</th><th>Aktion</th></tr></thead>
            <tbody>
              {items.map((q) => (
                <tr key={q.id}>
                  <td data-label="Formular"><strong>{q.code}</strong><div className="small">{q.title}</div></td>
                  <td data-label="Zielgruppe / Modul">{q.audience === 'arzt' ? 'Arzt' : 'Patient'} · {q.module_code}</td>
                  <td data-label="Versionen">{q.versions.filter((v: any) => v.id).map((v: any) => <div key={v.id}><Link href={`/formulare/${v.id}`}>V{v.version}</Link> <Badge tone={ST[v.status][1]}>{ST[v.status][0]}</Badge> {v.valid_from && <span className="small muted">gültig ab {fmtDate(v.valid_from)}{v.valid_to ? ` bis ${fmtDate(v.valid_to)}` : ''}</span>}</div>)}</td>
                  <td data-label="Aktion">{can(me, 'form.draft') && !q.versions.some((v: any) => ['entwurf', 'in_pruefung', 'freigegeben'].includes(v.status)) && <button className="btn-small btn-secondary" onClick={() => api(`/questionnaires/${q.id}/versions`, { body: {} }).then((r) => router.push(`/formulare/${r.versionId}`)).catch(setError)}>Neue Version</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(me, 'form.draft') && (
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          <form className="card" onSubmit={(e) => { e.preventDefault(); api('/questionnaires', { body: nf }).then((r) => router.push(`/formulare/${r.versionId}`)).catch(setError); }}>
            <h2>Neues Formular</h2>
            <div className="field"><label htmlFor="nc">Code (A–Z, 0–9, -)</label><input id="nc" type="text" value={nf.code} onChange={(e) => setNf({ ...nf, code: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label htmlFor="nt">Titel</label><input id="nt" type="text" value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} /></div>
            <div className="grid grid-2">
              <div className="field"><label htmlFor="na">Zielgruppe</label><select id="na" value={nf.audience} onChange={(e) => setNf({ ...nf, audience: e.target.value })}><option value="arzt">Arzt</option><option value="patient">Patient</option></select></div>
              <div className="field"><label htmlFor="nm">Modul</label><input id="nm" type="text" value={nf.module} onChange={(e) => setNf({ ...nf, module: e.target.value.toUpperCase() })} /></div>
            </div>
            <button type="submit" disabled={!nf.code || nf.title.length < 2}>Anlegen</button>
          </form>
          <form className="card" onSubmit={(e) => { e.preventDefault(); try { const j = JSON.parse(importText); api('/questionnaires/import', { body: j }).then((r) => router.push(`/formulare/${r.versionId}`)).catch(setError); } catch { setError(new ApiErr(400, 'VALIDIERUNG', 'Ungültiges JSON', null)); } }}>
            <h2>Import (versioniertes JSON)</h2>
            <p className="small muted">Ein Import legt immer einen neuen Entwurf an. Die Prüfsumme wird kontrolliert.</p>
            <div className="field"><label htmlFor="imp">Exportdatei (JSON-Inhalt)</label><textarea id="imp" rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} /></div>
            <button type="submit" className="btn-secondary" disabled={!importText}>Importieren</button>
          </form>
        </div>
      )}
      {!can(me, 'form.draft') && can(me, 'form.publish') && <Alert kind="info">Sie haben die Freigaberolle. Öffnen Sie eine Version „In Prüfung“, um sie freizugeben und zu veröffentlichen.</Alert>}
    </>
  );
}
