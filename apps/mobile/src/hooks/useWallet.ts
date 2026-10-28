import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';

export interface Wallet {
  id: string;
  address: string;
  chain: string;
}

export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api.get('/wallet/get', { params: { chain: 'ethereum' } });
      if (data?.address) {
        setWallet(data);
        try {
          const b = await api.get(`/wallet/${data.id}/balance`);
          setBalance(String(b.data.balance));
        } catch {
          setBalance(null);
        }
      } else {
        setWallet(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const createWallet = async () => {
    setError(null);
    try {
      await api.post('/wallet/create', { chain: 'ethereum' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not create your wallet.'));
    }
  };

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { wallet, balance, loading, error, refresh, createWallet };
}
