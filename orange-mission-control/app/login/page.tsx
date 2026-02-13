'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase/client';

export default function LoginPage() {
  const [mode, setMode] = useState<'magic' | 'password'>('magic');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = useMemo(() => {
    if (!email.trim()) return false;
    if (mode === 'password' && password.length < 6) return false;
    return true;
  }, [email, mode, password]);

  useEffect(() => {
    // If already signed in, bounce home
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.href = '/';
    });
  }, []);

  async function submit() {
    setBusy(true);
    setStatus(null);
    try {

      if (mode === 'magic') {
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) throw error;
        setStatus('Magic link sent. Check your email.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = '/';
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Login failed';
      setStatus(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fafafa' }}>
      <div
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: 16,
          background: 'white',
          padding: 18,
          fontFamily: 'ui-sans-serif, system-ui',
          boxShadow: '0 12px 50px rgba(0,0,0,0.08)',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, opacity: 0.7 }}>ORANGE VIDEOS</div>
        <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>Mission Control</div>
        <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>Sign in to continue.</div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            onClick={() => setMode('magic')}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 12,
              border: mode === 'magic' ? '2px solid #111' : '1px solid rgba(0,0,0,0.12)',
              background: mode === 'magic' ? '#fff' : '#f7f7f7',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Magic link
          </button>
          <button
            onClick={() => setMode('password')}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 12,
              border: mode === 'password' ? '2px solid #111' : '1px solid rgba(0,0,0,0.12)',
              background: mode === 'password' ? '#fff' : '#f7f7f7',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Password
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 800, opacity: 0.75 }}>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@domain.com"
            style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 12, border: '1px solid rgba(0,0,0,0.14)' }}
          />
        </div>

        {mode === 'password' ? (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, opacity: 0.75 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                width: '100%',
                marginTop: 6,
                padding: 10,
                borderRadius: 12,
                border: '1px solid rgba(0,0,0,0.14)',
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>Minimum 6 characters.</div>
          </div>
        ) : null}

        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          style={{
            marginTop: 14,
            width: '100%',
            padding: '12px 12px',
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.12)',
            background: '#111',
            color: 'white',
            fontWeight: 900,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: !canSubmit || busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Working…' : mode === 'magic' ? 'Send magic link' : 'Sign in'}
        </button>

        {status ? <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>{status}</div> : null}

        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.6, lineHeight: 1.35 }}>
          Pilot mode: single-user. Once you share your preferred login email, we’ll lock access down.
        </div>
      </div>
    </div>
  );
}
