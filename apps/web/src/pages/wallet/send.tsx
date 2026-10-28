import { useState } from 'react';
import Link from 'next/link';
import Layout, { Spinner } from '@/components/Layout';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useWallet } from '@/hooks/useWallet';
import { api, errorMessage } from '@/lib/api';
import { validateAmount, validateRecipient } from '@/lib/validation';

type Step = { kind: 'edit' } | { kind: 'review'; to: string; eth: string } | { kind: 'sent'; txHash?: string };

export default function Send() {
  const { user, loading: authLoading } = useRequireAuth();
  const { wallet, balance, loading } = useWallet(Boolean(user));
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<{ to?: string; amount?: string }>({});
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (authLoading || !user || loading) return <Spinner />;
  if (!wallet) {
    return (
      <Layout title="Send">
        <p className="text-gray-700">
          You need a wallet first. <Link href="/dashboard" className="text-primary underline">Create one</Link>.
        </p>
      </Layout>
    );
  }

  const review = (e: React.FormEvent) => {
    e.preventDefault();
    const r = validateRecipient(to, wallet.address);
    const a = validateAmount(amount, balance ?? undefined);
    setFieldError({ to: r.ok ? undefined : r.error, amount: a.ok ? undefined : a.error });
    if (r.ok && a.ok) setStep({ kind: 'review', to: r.value, eth: a.value.eth });
  };

  const confirm = async () => {
    if (step.kind !== 'review') return;
    setSubmitting(true);
    setSendError(null);
    try {
      const { data } = await api.post('/transactions/send', { walletId: wallet.id, to: step.to, amount: step.eth });
      setStep({ kind: 'sent', txHash: data?.txHash });
    } catch (err: any) {
      setSendError(
        err?.response?.status === 403
          ? 'This transfer was blocked by OpenPrivy’s compliance checks and was not sent. Contact support if you think this is a mistake.'
          : errorMessage(err, 'The transfer was not sent.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Layout title="Send">
      <Link href="/dashboard" className="text-sm text-gray-600 hover:underline">
        ← Back to wallet
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mt-2 mb-6">Send ETH</h1>

      {step.kind === 'edit' && (
        <form onSubmit={review} noValidate className="bg-white rounded-xl shadow p-6 space-y-5">
          <div>
            <label htmlFor="to" className="block text-sm font-medium text-gray-700 mb-1">
              Recipient address
            </label>
            <input
              id="to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              aria-invalid={Boolean(fieldError.to)}
              aria-describedby={fieldError.to ? 'to-error' : undefined}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
            />
            {fieldError.to && (
              <p id="to-error" className="text-sm text-red-700 mt-1">
                {fieldError.to}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700 mb-1">
              Amount (ETH)
            </label>
            <input
              id="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-invalid={Boolean(fieldError.amount)}
              aria-describedby={fieldError.amount ? 'amount-error' : 'amount-help'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 tabular-nums"
            />
            {fieldError.amount ? (
              <p id="amount-error" className="text-sm text-red-700 mt-1">
                {fieldError.amount}
              </p>
            ) : (
              <p id="amount-help" className="text-sm text-gray-500 mt-1">
                Available: {balance ?? '—'} ETH. Network fees are added on top.
              </p>
            )}
          </div>
          <button type="submit" className="bg-primary text-white font-semibold px-6 py-3 rounded-lg hover:opacity-90">
            Review
          </button>
        </form>
      )}

      {step.kind === 'review' && (
        <section className="bg-white rounded-xl shadow p-6 space-y-4">
          <p className="text-gray-700">Check every character of the address. Transfers cannot be reversed.</p>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-gray-500">To</dt>
              <dd className="font-mono text-sm break-all">{step.to}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Amount</dt>
              <dd className="text-xl font-bold tabular-nums">{step.eth} ETH</dd>
            </div>
          </dl>
          {sendError && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">
              {sendError}
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={confirm}
              disabled={submitting}
              className="bg-primary text-white font-semibold px-6 py-3 rounded-lg hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? 'Sending…' : `Send ${step.eth} ETH`}
            </button>
            <button onClick={() => setStep({ kind: 'edit' })} disabled={submitting} className="px-6 py-3 rounded-lg border border-gray-300">
              Edit
            </button>
          </div>
        </section>
      )}

      {step.kind === 'sent' && (
        <section className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Transfer submitted</h2>
          {step.txHash && (
            <p className="text-sm text-gray-600 break-all">
              Transaction: <code>{step.txHash}</code>
            </p>
          )}
          <Link href="/dashboard" className="inline-block mt-4 text-primary underline">
            Back to wallet
          </Link>
        </section>
      )}
    </Layout>
  );
}
