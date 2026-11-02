import { useEffect, useState } from 'react';
import PublicCard, { Alert } from '@/components/PublicCard';
import { useEmailToken } from '@/hooks/useEmailToken';
import { api, errorMessage } from '@/lib/api';

type Invite = { ownerName: string | null; ownerEmail: string; guardianName: string };

export default function AcceptGuardian() {
  const token = useEmailToken();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token === undefined) return;
    if (token === null) return setError('This invitation link is incomplete. Open it again from the email.');
    api
      .post<Invite>('/recovery/guardian-invites/lookup', { token })
      .then((r) => setInvite(r.data))
      .catch((e) => setError(errorMessage(e, 'This invitation link is invalid or has expired.')));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      await api.post('/recovery/guardian-invites/confirm', { token });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e, 'Could not accept the invitation.'));
    } finally {
      setBusy(false);
    }
  };

  const who = invite ? (invite.ownerName ? `${invite.ownerName} (${invite.ownerEmail})` : invite.ownerEmail) : '';
  return (
    <PublicCard title="Become a recovery guardian">
      {error && <Alert>{error}</Alert>}
      {done && <Alert kind="success">You are now a guardian for {who}. You can close this page.</Alert>}
      {invite && !done && (
        <>
          <p className="text-gray-700 mb-3">
            Hi {invite.guardianName}. <strong>{who}</strong> asked you to be a guardian for their OpenPrivy wallet.
          </p>
          <p className="text-gray-700 mb-6">
            If they ever lose access, you may be asked to confirm a recovery. Only approve after speaking to them
            directly. If you don&apos;t know this person, close this page.
          </p>
          <button onClick={accept} disabled={busy} className="w-full bg-primary text-white font-semibold py-3 rounded-lg disabled:opacity-60">
            {busy ? 'Accepting…' : 'Accept'}
          </button>
        </>
      )}
      {!invite && !error && <p className="text-gray-500">Loading…</p>}
    </PublicCard>
  );
}
