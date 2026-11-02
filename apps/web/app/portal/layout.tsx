export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar"><span className="brand">DART Register · Patientenportal</span></header>
      <div className="demo-banner" role="note">Demonstration mit synthetischen Daten – keine echte Teilnahme.</div>
      <main id="inhalt" className="portal">{children}</main>
    </>
  );
}
