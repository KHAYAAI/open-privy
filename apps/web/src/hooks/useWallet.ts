import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

export interface Wallet {
  id: string;
  address: string;
  chain: string;
  createdAt?: string;
}

export const useWallet = (enabled = true) => {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async (walletId: string) => {
    try {
      const { data } = await api.get(`/wallet/${walletId}/balance`);
      setBalance(String(data.balance));
    } catch {
      setBalance(null);
    }
  }, []);

  const fetchWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/wallet/get', { params: { chain: 'ethereum' } });
      if (data?.address) {
        setWallet(data);
        await fetchBalance(data.id);
      } else {
        setWallet(null);
      }
    } catch (err: any) {
      if (err?.response?.status === 404) setWallet(null);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [fetchBalance]);

  const createWallet = async () => {
    setError(null);
    try {
      const { data } = await api.post('/wallet/create', { chain: 'ethereum' });
      setWallet(data);
      await fetchBalance(data.id);
    } catch (err) {
      setError(errorMessage(err, 'Could not create your wallet.'));
    }
  };

  useEffect(() => {
    if (enabled) fetchWallet();
  }, [enabled, fetchWallet]);

  return { wallet, balance, loading, error, createWallet, refresh: fetchWallet };
};
