'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Alert, Badge, ConceptNote, ErrorBox } from '@/components/ui';

const ROLES: Record<string, string> = { zentrale_admin: 'Zentrale Administration', zentrumsverantwortlich: 'Zentrumsverantwortliche/r', arzt: 'Arzt/Ärztin', dokumentation: 'Dokumentationskraft', datenmanagement: 'Datenmanagement', formularredaktion: 'Formularredaktion', formularfreigabe: 'Formularfreigabe', forschung: 'Forschung', technik: 'Technischer Betrieb' };
const CENTER_BOUND = ['zentrumsverantwortlich', 'arzt', 'dokumentation'];

export default function Admin() {
  const [centers, setCenters] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [error, setError] = useState<ApiErr | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nc, setNc] = useState({ code: '', name: '' });
  const [nu, setNu] = useState({ username: '', displayName: '' });
  const [grant, setGrant] = useState<Record<string, { role: string; centerId: string }>>({});
  const load = useCallback(async () => {
    try {
      setCenters((await api('/admin/centers')).items);
      setUsers((await api('/admin/users')).items);
    } catch (e) {
      setError(e as ApiErr);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { setMsg(ok); setError(null); return load(); }).catch(setError);
  return (
    <>
      <h1>Administration</h1>
      <ConceptNote />
      <Alert kind="info">Zentrale Administration: Zentren, Konten und Rollen. Keine Selbstregistrierung; Änderungen sind sofort wirksam und werden auditiert. Kein Lesezugriff auf Identitäten oder Signaturen.</Alert>
      <ErrorBox error={error} />
      {msg && <Alert kind="success">{msg}</Alert>}
      <section className="card">
        <h2>Zentren</h2>
        <ul>{centers.map((c) => <li key={c.id}><strong>{c.code}</strong> {c.name} · Science-Freigabe: {c.science_approvals?.length ? c.science_approvals.map((a: any) => `ab ${fmtDate(a.valid_from)}${a.valid_to ? ` bis ${fmtDate(a.valid_to)}` : ''} (${a.approved_by})`).join('; ') : 'keine'}</li>)}</ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); act(api('/admin/centers', { body: nc }), 'Zentrum angelegt.'); }}>
          <label htmlFor="cc" className="sr-only">Code</label><input id="cc" type="text" placeholder="Code, z. B. Z-103" style={{ maxWidth: 160 }} value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} />
          <label htmlFor="cn" className="sr-only">Name</label><input id="cn" type="text" placeholder="Name" style={{ maxWidth: 320 }} value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} />
          <button type="submit" className="btn-secondary">Zentrum anlegen</button>
        </form>
      </section>
      <section className="card">
        <h2>Konten und Rollen</h2>
        <div className="table-wrap"><table className="data cards">
          <thead><tr><th>Konto</th><th>Rollen</th><th>Rolle vergeben</th><th>Status</th></tr></thead>
          <tbody>{users.map((u) => {
            const g = grant[u.id] ?? { role: 'arzt', centerId: centers[0]?.id ?? '' };
            return (
              <tr key={u.id}>
                <td data-label="Konto"><strong>{u.username}</strong><div className="small">{u.display_name}{u.is_demo ? ' · Demo' : ''}</div></td>
                <td data-label="Rollen">{u.roles.map((r: any) => <div key={r.id} className="small">{ROLES[r.role]}{r.centerName ? ` (${r.centerName})` : ''} <button className="btn-ghost btn-small" onClick={() => act(api(`/admin/users/${u.id}/roles/${r.id}/revoke`, { body: {} }), 'Rolle entzogen.')}>entziehen</button></div>)}</td>
                <td data-label="Rolle vergeben">
                  <div className="row">
                    <label className="sr-only" htmlFor={`r-${u.id}`}>Rolle</label>
                    <select id={`r-${u.id}`} style={{ width: 'auto' }} value={g.role} onChange={(e) => setGrant({ ...grant, [u.id]: { ...g, role: e.target.value } })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    {(CENTER_BOUND.includes(g.role) || g.role === 'datenmanagement') && <><label className="sr-only" htmlFor={`c-${u.id}`}>Zentrum</label><select id={`c-${u.id}`} style={{ width: 'auto' }} value={g.centerId} onChange={(e) => setGrant({ ...grant, [u.id]: { ...g, centerId: e.target.value } })}>{g.role === 'datenmanagement' && <option value="">zentral</option>}{centers.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></>}
                    <button className="btn-small" onClick={() => act(api(`/admin/users/${u.id}/roles`, { body: { role: g.role, centerId: CENTER_BOUND.includes(g.role) || (g.role === 'datenmanagement' && g.centerId) ? g.centerId : null } }), 'Rolle vergeben.')}>Vergeben</button>
                  </div>
                </td>
                <td data-label="Status">{u.active ? <Badge tone="ok">aktiv</Badge> : <Badge tone="bad">gesperrt</Badge>} <button className="btn-ghost btn-small" onClick={() => { const reason = window.prompt(u.active ? 'Grund der Sperrung' : 'Grund der Entsperrung'); if (reason) void act(api(`/admin/users/${u.id}/lock`, { body: { locked: u.active, reason } }), u.active ? 'Konto gesperrt (sofort wirksam).' : 'Konto entsperrt.'); }}>{u.active ? 'Sperren' : 'Entsperren'}</button></td>
              </tr>
            );
          })}</tbody>
        </table></div>
        <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); act(api('/admin/users', { body: nu }), 'Konto angelegt. Bitte Rollen vergeben.'); }}>
          <label htmlFor="un" className="sr-only">Benutzername</label><input id="un" type="text" placeholder="benutzername" style={{ maxWidth: 200 }} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.toLowerCase() })} />
          <label htmlFor="ud" className="sr-only">Anzeigename</label><input id="ud" type="text" placeholder="Anzeigename" style={{ maxWidth: 280 }} value={nu.displayName} onChange={(e) => setNu({ ...nu, displayName: e.target.value })} />
          <button type="submit" className="btn-secondary">Konto anlegen</button>
        </form>
      </section>
      <section className="card">
        <h2>Audit</h2>
        <button className="btn-ghost btn-small" onClick={() => api('/admin/audit?limit=100').then((r) => setAudit(r.items)).catch(setError)}>Letzte 100 Ereignisse laden</button>
        {audit && <div className="table-wrap" style={{ marginTop: 8 }}><table className="data cards"><thead><tr><th>Zeit</th><th>Akteur</th><th>Aktion</th><th>Objekt</th><th>Ergebnis</th></tr></thead>
          <tbody>{audit.map((a) => <tr key={a.id}><td data-label="Zeit">{fmtDateTime(a.at)}</td><td data-label="Akteur">{a.username ?? a.actor_kind} <span className="small muted">{a.actor_roles?.join(', ')}</span></td><td data-label="Aktion">{a.action}{a.reason ? <div className="small muted">{a.reason}</div> : null}</td><td data-label="Objekt">{a.object_type} {a.object_id?.slice(0, 8)}</td><td data-label="Ergebnis">{a.result}</td></tr>)}</tbody>
        </table></div>}
      </section>
    </>
  );
}
