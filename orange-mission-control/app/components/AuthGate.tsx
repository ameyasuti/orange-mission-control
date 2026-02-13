'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

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

    const allowed = process.env.NEXT_PUBLIC_ALLOWED_EMAIL?.trim().toLowerCase();

    (async () => {
      // If signed in with the wrong email, sign out immediately (pilot guard)
      const { data } = await supabase.auth.getUser();
      const currentEmail = data.user?.email?.toLowerCase();
      if (allowed && currentEmail && currentEmail !== allowed) {
        await supabase.auth.signOut();
        window.location.assign('/login');
        return;
      }

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
