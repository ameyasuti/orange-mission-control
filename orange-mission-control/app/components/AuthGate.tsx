'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';

type Props = {
  children: React.ReactNode;
};

export default function AuthGate({ children }: Props) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setAuthed(!!data.session);
      setReady(true);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthed(!!session);
      setReady(true);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;

    (async () => {
      if (!authed && typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    })();
  }, [ready, authed]);

  if (!ready) {
    return (
      <div style={{ padding: 24, fontFamily: 'ui-sans-serif, system-ui' }}>
        Loading…
      </div>
    );
  }

  if (!authed) return null;

  return <>{children}</>;
}
