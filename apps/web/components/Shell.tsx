'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { can, useMe } from '@/lib/session';

const NAV: Array<{ href: string; label: string; perm?: string }> = [
  { href: '/uebersicht', label: 'Übersicht', perm: 'case.read' },
  { href: '/faelle/neu', label: 'Fall anlegen', perm: 'case.write' },
  { href: '/nachweise', label: 'Nachweise prüfen', perm: 'consent.review' },
  { href: '/auswertung', label: 'Auswertung & Export' },
  { href: '/formulare', label: 'Formulare', perm: 'form.read' },
  { href: '/migration', label: 'Migration', perm: 'migration.run' },
  { href: '/admin', label: 'Administration', perm: 'admin.manage' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const router = useRouter();
  const items = NAV.filter((n) => {
    if (n.href === '/auswertung') return can(me, 'report.read') || can(me, 'export.request') || can(me, 'export.approve');
    return !n.perm || can(me, n.perm);
  });
  const centerLabel = me.centers.length === 1 ? me.centers[0].name : me.centers.length > 1 ? `${me.centers.length} Zentren` : 'Zentral';
  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    router.replace('/anmelden');
  }
  return (
    <>
      <header className="topbar">
        <Link href="/uebersicht" className="brand">DART 2.0</Link>
        <div className="who">
          <span>{centerLabel} / {me.displayName}</span>
          <span className="small" style={{ opacity: 0.85 }}>{me.roles.map((r) => r.label).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</span>
          <button className="btn-small" onClick={logout}>Abmelden</button>
        </div>
      </header>
      <div className="demo-banner" role="note">Prototyp – ausschließlich synthetische Daten. Keine Freigabe für echte Patientendaten.</div>
      <div className="layout">
        <nav className="sidenav" aria-label="Hauptnavigation">
          <ul>
            {items.map((n) => (
              <li key={n.href}>
                <Link href={n.href} aria-current={path === n.href || (n.href !== '/uebersicht' && path.startsWith(n.href) && !(n.href === '/faelle/neu' && path !== n.href)) ? 'page' : undefined}>{n.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="inhalt" tabIndex={-1}>
          <div className="container">{children}</div>
        </main>
      </div>
    </>
  );
}
