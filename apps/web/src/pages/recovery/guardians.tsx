import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout, { Spinner } from '@/components/Layout';
import { Alert } from '@/components/PublicCard';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { api, errorMessage } from '@/lib/api';

type Guardian = { id: string; name: string; email: string; status: 'pending' | 'active' };
type Summary = { guardians: Guardian[]; activeGuardians: number; threshold: number | null; recoveryReady: boolean; minimumGuardians: number };

export default function Guardians() {
  const { user, loading: authLoading } = useRequireAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData((await api.get<Summary>('/recovery/guardians')).data);
    } catch (e: any) {
      setError(e?.response?.status === 404 ? 'Account recovery is not available yet.' : errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (authLoading || !user) return <Spinner />;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/recovery/guardians', { name, email });
      setName('');
      setEmail('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not add that guardian.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api.delete(`/recovery/guardians/${id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not remove that guardian.'));
    }
  };

  const full = (data?.guardians.length ?? 0) >= 5;
  return (
    <Layout title="Recovery guardians">
      <Link href="/dashboard" className="text-sm text-gray-600 hover:underline">
        ← Back to wallet
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mt-2 mb-2">Recovery guardians</h1>
      <p className="text-gray-600 mb-6 max-w-prose">
        If you ever lose access to your account, a majority of these people can help move your wallet to a new
        account. Pick people you trust who know you well. Each one confirms by email.
      </p>
      {error && <Alert>{error}</Alert>}
      {data && (
        <>
          <p className="mb-4">
            {data.recoveryReady ? (
              <span className="inline-block text-sm bg-green-50 text-green-800 rounded px-2 py-1">
                Recovery is set up: {data.threshold} of {data.activeGuardians} guardians must approve.
              </span>
            ) : (
              <span className="inline-block text-sm bg-amber-50 text-amber-900 rounded px-2 py-1">
                Not set up yet: you need {data.minimumGuardians} confirmed guardians ({data.activeGuardians} so far).
              </span>
            )}
          </p>
          <ul className="bg-white rounded-xl shadow divide-y divide-gray-100 mb-6">
            {data.guardians.length === 0 && <li className="p-4 text-gray-500">No guardians yet.</li>}
            {data.guardians.map((g) => (
              <li key={g.id} className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{g.name}</p>
                  <p className="text-sm text-gray-500 break-all">{g.email}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-xs rounded px-2 py-1 ${g.status === 'active' ? 'bg-green-50 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                    {g.status === 'active' ? 'Confirmed' : 'Waiting for them'}
                  </span>
                  <button onClick={() => remove(g.id)} className="text-sm text-red-700 hover:underline">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!full && (
            <form onSubmit={add} className="bg-white rounded-xl shadow p-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="g-name" className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input id="g-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} className="w-full border border-gray-300 rounded-lg px-3 py-2" />
              </div>
              <div>
                <label htmlFor="g-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input id="g-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full border border-gray-300 rounded-lg px-3 py-2" />
              </div>
              <button type="submit" disabled={busy} className="sm:col-span-2 bg-primary text-white font-semibold py-3 rounded-lg disabled:opacity-60">
                {busy ? 'Sending invitation…' : 'Invite guardian'}
              </button>
            </form>
          )}
        </>
      )}
    </Layout>
  );
}
