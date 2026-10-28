import { useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '@/context/AuthContext';

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [user, loading, router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-purple-800 to-blue-900 flex items-center justify-center px-4">
      <Head>
        <title>OpenPrivy</title>
      </Head>
      <div className="text-center max-w-xl">
        <h1 className="text-5xl font-bold text-white mb-4">OpenPrivy</h1>
        <p className="text-lg text-purple-100 mb-8">
          A crypto wallet that works like any other account. Sign in, and your wallet is ready. No seed phrase to lose.
        </p>
        <Link href="/auth/login" className="inline-block bg-white text-purple-900 font-semibold px-8 py-3 rounded-lg hover:bg-purple-50">
          Get started
        </Link>
      </div>
    </div>
  );
}
