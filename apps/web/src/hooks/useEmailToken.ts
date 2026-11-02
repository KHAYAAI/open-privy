import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * Reads the one-time token from an emailed link, then removes it from the
 * address bar and history so it is not left in the URL. Returns undefined
 * until the router is ready, null if the link has no valid token.
 */
export function useEmailToken(): string | null | undefined {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!router.isReady || token !== undefined) return;
    const t = router.query.token;
    const valid = typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
    setToken(valid);
    window.history.replaceState(null, '', window.location.pathname);
  }, [router.isReady, router.query.token, token]);
  return token;
}
