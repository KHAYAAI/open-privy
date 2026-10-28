import { useState } from 'react';
import Link from 'next/link';
import Layout, { Spinner } from '@/components/Layout';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useWallet } from '@/hooks/useWallet';

export default function Dashboard() {
  const { user, loading: authLoading } = useRequireAuth();
  const { wallet, balance, loading, error, createWallet } = useWallet(Boolean(user));
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  if (authLoading || !user) return <Spinner />;

  const copy = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: address is still selectable */
    }
  };

  return (
    <Layout title="Wallet">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Your wallet</h1>
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700 bg-red-50 rounded p-3">
          {error}
        </p>
      )}
      {loading ? (
        <Spinner />
      ) : wallet ? (
        <section className="bg-white rounded-xl shadow p-6">
          <p className="text-sm text-gray-500 mb-1">Balance (Ethereum)</p>
          {balance === null ? (
            <p className="text-gray-600 mb-6">Your balance cannot be loaded right now. Refresh to try again.</p>
          ) : (
            <p className="text-3xl font-bold text-gray-900 mb-6 tabular-nums">{balance} ETH</p>
          )}
          <p className="text-sm text-gray-500 mb-1">Your address</p>
          <div className="flex items-center gap-2 mb-6">
            <code className="text-sm break-all bg-gray-50 rounded px-2 py-1 select-all">{wallet.address}</code>
            <button onClick={copy} className="text-sm text-primary whitespace-nowrap">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <Link href="/wallet/send" className="inline-block bg-primary text-white font-semibold px-6 py-3 rounded-lg hover:opacity-90">
            Send
          </Link>
        </section>
      ) : (
        <section className="bg-white rounded-xl shadow p-6">
          <p className="text-gray-700 mb-4">You do not have a wallet yet. Create one to receive and send ETH.</p>
          <button
            onClick={async () => {
              setCreating(true);
              await createWallet();
              setCreating(false);
            }}
            disabled={creating}
            className="bg-primary text-white font-semibold px-6 py-3 rounded-lg hover:opacity-90 disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create wallet'}
          </button>
        </section>
      )}
      <p className="mt-6 text-sm text-gray-500">
        Your private key is encrypted and held by OpenPrivy, so there is no seed phrase to write down.
      </p>
    </Layout>
  );
}
