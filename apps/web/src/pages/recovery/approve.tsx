import { useEffect, useState } from 'react';
import PublicCard, { Alert } from '@/components/PublicCard';
import { useEmailToken } from '@/hooks/useEmailToken';
import { api, errorMessage } from '@/lib/api';

type Details = { ownerName: string | null; ownerEmail: string; requestedBy: string; requestedAt: string; timeLockHours: number };

export default function ApproveRecovery() {
  const token = useEmailToken();
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [result, setResult] = useState<'approved' | 'declined' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token === undefined) return;
    if (token === null) return setError('This link is incomplete. Open it again from the email.');
    api
      .post<Details>('/recovery/approvals/lookup', { token })
      .then((r) => setDetails(r.data))
      .catch((e) => setError(errorMessage(e, 'This link is invalid, already used, or the request is closed.')));
  }, [token]);

  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    try {
      await api.post('/recovery/approvals/decide', { token, decision });
      setResult(decision === 'approve' ? 'approved' : 'declined');
    } catch (e) {
      setError(errorMessage(e, 'Your answer was not recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const owner = details ? details.ownerName || details.ownerEmail : '';
  return (
    <PublicCard title="Confirm a wallet recovery">
      {error && <Alert>{error}</Alert>}
      {result === 'approved' && <Alert kind="success">Thank you. Your approval was recorded.</Alert>}
      {result === 'declined' && <Alert kind="success">You declined. The recovery request has been stopped.</Alert>}
      {details && !result && (
        <>
          <dl className="space-y-2 mb-4 text-sm">
            <div>
              <dt className="text-gray-500">Wallet owner</dt>
              <dd className="font-medium">{details.ownerName ? `${details.ownerName} (${details.ownerEmail})` : details.ownerEmail}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Requested by the account</dt>
              <dd className="font-medium break-all">{details.requestedBy}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Requested</dt>
              <dd>{new Date(details.requestedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <Alert kind="warning">
            Approving helps move {owner}&apos;s wallet to the account above. Scammers impersonate people who
            &quot;lost their phone&quot;. Call or meet {owner} first, using contact details you already had.
          </Alert>
          <label className="flex gap-2 items-start text-sm text-gray-700 mb-5">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1" />
            I spoke to {owner} directly and they confirmed they lost access and made this request.
          </label>
          <div className="flex gap-3">
            <button
              onClick={() => decide('approve')}
              disabled={!checked || busy}
              className="flex-1 bg-primary text-white font-semibold py-3 rounded-lg disabled:opacity-50"
            >
              Approve
            </button>
            <button onClick={() => decide('decline')} disabled={busy} className="flex-1 border border-gray-300 font-semibold py-3 rounded-lg">
              Decline
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-4">
            If enough guardians approve, the wallet moves after a {details.timeLockHours}-hour wait, during which{' '}
            {owner} can still stop it.
          </p>
        </>
      )}
      {!details && !error && <p className="text-gray-500">Loading…</p>}
    </PublicCard>
  );
}
