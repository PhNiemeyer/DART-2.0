'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiErr } from './api';

export interface Me {
  userId: string;
  username: string;
  displayName: string;
  roles: Array<{ role: string; centerId: string | null; label: string }>;
  centers: Array<{ id: string; code: string; name: string }>;
  permissions: string[];
  isDemo: boolean;
}

const Ctx = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(Ctx);
  if (!me) throw new Error('Keine Sitzung');
  return me;
}

export function can(me: Me, perm: string): boolean {
  return me.permissions.includes(perm);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e: ApiErr) => {
        if (e.status === 401) router.replace('/anmelden');
        else setError(e.message);
      });
  }, [router]);
  if (error) return <div className="container" style={{ padding: 24 }}><div className="alert alert-error" role="alert">{error}</div></div>;
  if (!me) return <div className="container" style={{ padding: 24 }} aria-busy="true"><p className="muted">Sitzung wird geladen …</p></div>;
  return <Ctx.Provider value={me}>{children}</Ctx.Provider>;
}
