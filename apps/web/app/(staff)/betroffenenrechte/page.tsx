'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { DSR_CHANNEL, DSR_KIND, DSR_STATUS, fristText } from '@/lib/dsr';
import { fmtDate } from '@/lib/format';
import { can, useMe } from '@/lib/session';
import { Alert, Badge, ConceptNote, ErrorBox, Loading } from '@/components/ui';

const FILTERS: Array<[string, string]> = [['offen', 'Offen'], ['ueberfaellig', 'Überfällig'], ['abgeschlossen', 'Abgeschlossen'], ['alle', 'Alle']];

export default function Betroffenenrechte() {
  const me = useMe();
  const record = can(me, 'dsr.record');
  const [summary, setSummary] = useState<any>(null);
  const [filter, setFilter] = useState('offen');
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);

  useEffect(() => { api('/dsr/summary').then(setSummary).catch(setError); }, []);
  useEffect(() => { if (record) { setList(null); api(`/dsr?status=${filter}`).then((r) => setList(r.items)).catch(setError); } }, [filter, record]);

  return (
    <>
      <h1>Betroffenenrechte</h1>
      <ConceptNote />
      <p className="muted">Anträge auf Auskunft, Berichtigung, Einschränkung, Widerruf und Löschung mit Fristen und Identitätsprüfung. Neue Anträge erfassen Sie im jeweiligen Fall.</p>
      <ErrorBox error={error} />
      {!summary && !error && <Loading what="Übersicht" />}
      {summary?.ebene === 'zentrum' && (
        <section className="grid grid-3" aria-label="Kennzahlen" style={{ marginBottom: 16 }}>
          <button className="kpi" style={{ textAlign: 'left' }} aria-pressed={filter === 'offen'} onClick={() => setFilter('offen')}><div className="num">{summary.offen}</div><div>offene Anträge</div></button>
          <button className="kpi" style={{ textAlign: 'left' }} aria-pressed={filter === 'ueberfaellig'} onClick={() => setFilter('ueberfaellig')}><div className="num">{summary.ueberfaellig}</div><div>überfällig</div></button>
          <div className="kpi"><div className="num">{summary.bald_faellig}</div><div>in den nächsten 7 Tagen fällig</div></div>
        </section>
      )}
      {summary?.ebene === 'zentral' && (
        <section className="card" aria-labelledby="h-zentral">
          <h2 id="h-zentral">Übersicht aller Zentren</h2>
          <p className="small muted">{summary.hinweis}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Zentrum</th><th>Art</th><th>Offen</th><th>Davon überfällig</th><th>Abgeschlossen</th></tr></thead>
              <tbody>
                {summary.byCenter.length === 0 && <tr><td colSpan={5}>Keine Anträge.</td></tr>}
                {summary.byCenter.map((r: any, i: number) => <tr key={i}><td>{r.center_code} – {r.center_name}</td><td>{DSR_KIND[r.kind] ?? r.kind}</td><td>{r.offen}</td><td>{r.ueberfaellig > 0 ? <Badge tone="bad">{r.ueberfaellig} überfällig</Badge> : 0}</td><td>{r.erledigt}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {record && (
        <section className="card" aria-labelledby="h-list">
          <h2 id="h-list">Anträge</h2>
          <div className="row" role="group" aria-label="Filter">
            {FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'btn-small' : 'btn-ghost btn-small'} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          {!list && <Loading what="Anträge" />}
          {list?.length === 0 && <Alert kind="info" title="Keine Anträge">Für diesen Filter liegen keine Anträge vor.</Alert>}
          {list && list.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="cards">
                <thead><tr><th>Art</th><th>Fall</th><th>Eingang</th><th>Frist</th><th>Status</th><th>Identität</th></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const open = ['offen', 'in_bearbeitung'].includes(r.status);
                    const f = fristText(r.tage_bis_frist, open);
                    return (
                      <tr key={r.id}>
                        <td data-label="Art"><Link href={`/betroffenenrechte/${r.id}`}>{DSR_KIND[r.kind]}</Link></td>
                        <td data-label="Fall" style={{ whiteSpace: 'nowrap' }}><strong>{r.case_no ?? '–'}</strong><div className="small muted">{r.pseudonym}{r.eingeschraenkt ? ' · eingeschränkt' : ''}</div></td>
                        <td data-label="Eingang">{fmtDate(r.received_at)} <span className="small muted">({DSR_CHANNEL[r.channel]})</span></td>
                        <td data-label="Frist">{fmtDate(r.frist)}{r.extended_due_date ? ' (verlängert)' : ''}<div><Badge tone={f.tone}>{f.text}</Badge></div></td>
                        <td data-label="Status"><Badge tone={DSR_STATUS[r.status].tone}>{DSR_STATUS[r.status].label}</Badge></td>
                        <td data-label="Identität">{r.identitaet_geprueft ? 'geprüft' : 'noch nicht geprüft'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
