'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiErr } from '@/lib/api';
import { ErrorBox, Loading } from '@/components/ui';

interface DevUser { username: string; display_name: string; roles: string[] }
const ROLE: Record<string, string> = { zentrale_admin: 'Zentrale Administration', zentrumsverantwortlich: 'Zentrumsverantwortliche/r', arzt: 'Arzt/Ärztin', dokumentation: 'Dokumentationskraft', datenmanagement: 'Datenmanagement', formularredaktion: 'Formularredaktion', formularfreigabe: 'Formularfreigabe', forschung: 'Forschung', technik: 'Technischer Betrieb' };

export default function Login() {
  const [mode, setMode] = useState<{ authMode: string } | null>(null);
  const [users, setUsers] = useState<DevUser[]>([]);
  const [error, setError] = useState<ApiErr | null>(null);
  const router = useRouter();
  useEffect(() => {
    api('/auth/mode').then(async (m) => {
      setMode(m);
      if (m.authMode === 'dev') setUsers((await api('/auth/dev-users')).items);
    }).catch(setError);
  }, []);
  async function login(username: string) {
    try {
      await api('/auth/dev-login', { body: { username } });
      router.replace('/uebersicht');
    } catch (e) {
      setError(e as ApiErr);
    }
  }
  return (
    <>
      <header className="topbar"><span className="brand">DART 2.0</span><span className="small">Registerplattform – Prototyp</span></header>
      <div className="demo-banner" role="note">Prototyp – ausschließlich synthetische Daten. Keine Freigabe für echte Patientendaten.</div>
      <main id="inhalt" className="container" style={{ maxWidth: 760, padding: 24 }}>
        <h1>Anmeldung</h1>
        <ErrorBox error={error} />
        {!mode && !error && <Loading what="Anmeldeoptionen" />}
        {mode?.authMode === 'oidc' && (
          <div className="card">
            <p>Die Anmeldung erfolgt über den zentralen Identitätsdienst (Keycloak) mit Mehr-Faktor-Authentisierung.</p>
            <a className="btn" href="/api/v1/auth/oidc/start">Anmelden</a>
          </div>
        )}
        {mode?.authMode === 'dev' && (
          <div className="card">
            <h2>Demo-Zugang (nur lokale Entwicklung)</h2>
            <p className="muted">Diese Auswahl ist ausschließlich für die lokale Entwicklung aktiv und wird in Produktion verweigert. Keine Selbstregistrierung.</p>
            <ul className="grid grid-2" style={{ listStyle: 'none', padding: 0 }}>
              {users.map((u) => (
                <li key={u.username}>
                  <button data-user={u.username} className="btn-ghost" style={{ width: "100%", justifyContent: 'flex-start', textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => login(u.username)}>
                    <span>{u.display_name}</span>
                    <span className="small muted" style={{ fontWeight: 400 }}>{u.username} · {u.roles.map((r) => { const [role, c] = r.split(':'); return `${ROLE[role] ?? role}${c ? ` (${c})` : ''}`; }).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
