'use client';
import { Shell } from '@/components/Shell';
import { SessionProvider } from '@/lib/session';

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
