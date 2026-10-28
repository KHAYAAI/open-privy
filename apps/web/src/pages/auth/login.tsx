import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/context/AuthContext';

export default function Login() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [user, loading, router]);

  const onContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await login();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <Head>
        <title>Sign in · OpenPrivy</title>
      </Head>
      <div className="w-full max-w-sm bg-white rounded-xl shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Sign in to OpenPrivy</h1>
        <p className="text-gray-600 mb-6 text-sm">
          New here? The same button creates your account. You can use your work SSO, Google, or email.
        </p>
        {router.query.expired && !error && (
          <p className="mb-4 text-sm text-amber-800 bg-amber-50 rounded p-3">Your session ended. Sign in again to continue.</p>
        )}
        {error && (
          <p role="alert" className="mb-4 text-sm text-red-700 bg-red-50 rounded p-3">
            {error}
          </p>
        )}
        <button
          onClick={onContinue}
          disabled={busy}
          className="w-full bg-primary text-white font-semibold py-3 rounded-lg hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Opening sign-in…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
