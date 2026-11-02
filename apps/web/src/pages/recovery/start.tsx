import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout, { Spinner } from '@/components/Layout';
import { Alert } from '@/components/PublicCard';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { api, errorMessage } from '@/lib/api';

type Status = {
  status: 'none' | 'awaiting_approvals' | 'time_locked' | 'completing' | 'completed' | 'cancelled' | 'declined' | 'expired';
  approvals?: number;
  threshold?: number;
  unlocksAt?: string | null;
  closedReason?: string | null;
};

const CLOSED: Record<string, string> = {
  cancelled: 'The recovery was stopped by the account owner.',
  declined: 'A guardian declined the recovery.',
  expired: 'Not enough guardians approved in time.',
};

export default function StartRecovery() {
  const { user, loading: authLoading } = useRequireAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [oldEmail, setOldEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus((await api.get<Status>('/recovery/requests/current')).data);
    } catch (e: any) {
      setError(e?.response?.status === 404 ? 'Account recovery is not available yet.' : errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (authLoading || !user) return <Spinner />;

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<{ message: string }>('/recovery/requests', { oldAccountEmail: oldEmail });
      setMessage(data.message);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not start the recovery.'));
    } finally {
      setBusy(false);
    }
  };

  const open = status && ['awaiting_approvals', 'time_locked', 'completing'].includes(status.status);
  return (
    <Layout title="Recover an old account">
      <Link href="/dashboard" className="text-sm text-gray-600 hover:underline">
        ← Back to wallet
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mt-2 mb-2">Recover an old account</h1>
      <p className="text-gray-600 mb-6 max-w-prose">
        Lost access to the account your wallet was on? You&apos;re signed in as <strong>{user.email}</strong>. If the old
        account set up recovery guardians, they can approve moving its wallet to this account.
      </p>
      {error && <Alert>{error}</Alert>}
      {message && <Alert kind="success">{message}</Alert>}

      {status?.status === 'completed' && (
        <Alert kind="success">
          Recovery complete. The wallet is now on this account. <Link href="/dashboard" className="underline">Open your wallet</Link>.
        </Alert>
      )}
      {status && CLOSED[status.status] && <Alert kind="warning">{CLOSED[status.status]}</Alert>}

      {open && (
        <section className="bg-white rounded-xl shadow p-6">
          {status.status === 'awaiting_approvals' && (
            <p className="text-gray-700">
              Waiting for guardians: <strong>{status.approvals}</strong> of <strong>{status.threshold}</strong> approvals.
            </p>
          )}
          {status.status !== 'awaiting_approvals' && status.unlocksAt && (
            <p className="text-gray-700">
              Guardians approved. The wallet moves to this account after{' '}
              <strong>{new Date(status.unlocksAt).toLocaleString()}</strong> unless the old account stops it.
            </p>
          )}
          <button onClick={load} className="mt-4 text-sm text-primary underline">Refresh</button>
        </section>
      )}

      {!open && status?.status !== 'completed' && (
        <form onSubmit={start} className="bg-white rounded-xl shadow p-6 space-y-4 max-w-lg">
          <div>
            <label htmlFor="old-email" className="block text-sm font-medium text-gray-700 mb-1">Email of the old account</label>
            <input id="old-email" type="email" value={oldEmail} onChange={(e) => setOldEmail(e.target.value)} required className="w-full border border-gray-300 rounded-lg px-3 py-2" />
          </div>
          <button type="submit" disabled={busy} className="bg-primary text-white font-semibold px-6 py-3 rounded-lg disabled:opacity-60">
            {busy ? 'Sending…' : 'Ask my guardians'}
          </button>
          <p className="text-xs text-gray-500">The old account is notified and can stop the request.</p>
        </form>
      )}
    </Layout>
  );
}
