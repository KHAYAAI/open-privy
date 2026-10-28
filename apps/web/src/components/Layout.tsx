import Head from 'next/head';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

export default function Layout({ title, children }: { title: string; children: React.ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-gray-50">
      <Head>
        <title>{`${title} · OpenPrivy`}</title>
      </Head>
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="font-bold text-primary">
            OpenPrivy
          </Link>
          {user && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-gray-500 hidden sm:inline">{user.email}</span>
              <button onClick={logout} className="text-gray-700 hover:text-gray-900 underline-offset-2 hover:underline">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]" role="status" aria-label="Loading">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
    </div>
  );
}
