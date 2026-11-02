import Head from 'next/head';

/** Centered card for pages opened from an email link (no sign-in needed). */
export default function PublicCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <Head>
        <title>{`${title} · OpenPrivy`}</title>
      </Head>
      <main className="w-full max-w-md bg-white rounded-xl shadow p-8">
        <p className="font-bold text-primary mb-4">OpenPrivy</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'warning'; children: React.ReactNode }) {
  const styles = {
    error: 'text-red-700 bg-red-50',
    success: 'text-green-800 bg-green-50',
    warning: 'text-amber-900 bg-amber-50',
  }[kind];
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`text-sm rounded p-3 mb-4 ${styles}`}>
      {children}
    </p>
  );
}
