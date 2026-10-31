import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/context/AuthContext';

/** Redirects to sign-in when there is no session. Returns the auth state. */
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!auth.loading && !auth.user) router.replace('/auth/login');
  }, [auth.loading, auth.user, router]);
  return auth;
}
