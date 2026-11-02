'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiErr } from '@/lib/api';
import { Alert, ErrorBox } from '@/components/ui';

/**
 * Einladungsseite: Der Token steht im URL-Fragment (#t=…) und wird nie an den Server gesendet,
 * bevor die Person bewusst bestätigt. Linkscanner (GET) lösen nichts aus.
 */
export default function Invitation() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [step, setStep] = useState<'start' | 'code' | 'done'>('start');
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiErr | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(window.location.hash);
    setToken(m ? m[1] : null);
    // Fragment aus der Adresszeile entfernen
    if (m) history.replaceState(null, '', window.location.pathname);
  }, []);

  async function redeem() {
    setBusy(true);
    setError(null);
    try {
      await api('/portal/redeem', { body: { token } });
      setStep('code');
      setTimeout(() => document.getElementById('code')?.focus(), 0);
    } catch (e) {
      const err = e as ApiErr;
      setError(err);
      setCanResend(!!err.body?.canResend);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/portal/verify', { body: { code } });
      if (r.ok) router.replace('/portal');
      else setInfo(r.message + (r.remainingAttempts ? ` Verbleibende Versuche: ${r.remainingAttempts}.` : ''));
    } catch (err) {
      setError(err as ApiErr);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Ihre persönliche Einladung</h1>
      <ErrorBox error={error} />
      {canResend && token && <button className="btn-secondary" onClick={() => api('/portal/resend', { body: { token } }).then((r) => setInfo(r.message)).catch(setError)}>Neuen Link anfordern</button>}
      {info && <Alert kind="info">{info}</Alert>}
      {token === null && <Alert kind="warning">Kein gültiger Einladungslink. Bitte öffnen Sie den vollständigen Link aus Ihrer E-Mail oder wenden Sie sich an Ihr Zentrum.</Alert>}
      {token && step === 'start' && (
        <div className="card">
          <p>Sie wurden eingeladen, am Register teilzunehmen beziehungsweise eine Befragung auszufüllen. Die Teilnahme ist freiwillig.</p>
          <p>Bitte bestätigen Sie, dass Sie den Zugang jetzt öffnen möchten. Der Link ist nur einmal verwendbar.</p>
          <button onClick={redeem} disabled={busy}>Zugang jetzt öffnen</button>
        </div>
      )}
      {step === 'code' && (
        <form className="card" onSubmit={verify}>
          <h2>Persönlicher Zugangscode</h2>
          <p>Bitte geben Sie den Zugangscode ein, den Sie in Ihrem Zentrum persönlich erhalten haben.</p>
          <div className="field"><label htmlFor="code">Zugangscode</label><input id="code" type="text" autoComplete="one-time-code" inputMode="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: 2, fontSize: '1.2rem' }} /></div>
          <button type="submit" disabled={busy || code.trim().length < 4}>Bestätigen</button>
        </form>
      )}
    </>
  );
}
