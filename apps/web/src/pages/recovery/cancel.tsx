import { useState } from 'react';
import PublicCard, { Alert } from '@/components/PublicCard';
import { useEmailToken } from '@/hooks/useEmailToken';
import { api, errorMessage } from '@/lib/api';

export default function CancelRecovery() {
  const token = useEmailToken();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try {
      await api.post('/recovery/requests/cancel', { token });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e, 'This link is invalid or the request is already closed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicCard title="Stop this recovery">
      {token === null && <Alert>This link is incomplete. Open it again from the email.</Alert>}
      {error && <Alert>{error}</Alert>}
      {done ? (
        <Alert kind="success">
          The recovery was stopped. Your wallet stays with your account. If you didn&apos;t start it, someone may be
          targeting you: consider telling your guardians.
        </Alert>
      ) : (
        token && (
          <>
            <p className="text-gray-700 mb-6">
              Someone asked to move your OpenPrivy wallet to another account. If that wasn&apos;t you, stop it now.
            </p>
            <button onClick={cancel} disabled={busy} className="w-full bg-red-700 text-white font-semibold py-3 rounded-lg disabled:opacity-60">
              {busy ? 'Stopping…' : 'This wasn’t me. Stop the recovery'}
            </button>
          </>
        )
      )}
    </PublicCard>
  );
}
