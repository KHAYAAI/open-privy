import { create } from 'zustand';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { api, setApiSession, errorMessage } from '../lib/api';
import { base64ToBase64Url, verifierFromRandomBytes, codeFromRedirect } from '../lib/pkce';
import { isTokenUsable } from '../lib/token';
import { isTrustedAuthUrl } from '../lib/validation';
import { clearSession, readToken, saveToken } from '../lib/secureSession';

const APP_REDIRECT = 'openprivy://auth';

export interface User {
  id: string;
  email: string;
  username?: string;
}

interface AuthStore {
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  initializeAuth: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => {
  const adopt = async (token: string) => {
    setApiSession(token, () => get().signOut());
    const { data } = await api.get<User>('/auth/me');
    set({ user: data, token, error: null });
  };

  return {
    user: null,
    token: null,
    loading: false,
    error: null,

    /** Restores a saved session (shows the biometric prompt if the lock is on). */
    initializeAuth: async () => {
      const token = await readToken();
      if (!isTokenUsable(token)) {
        if (token) await clearSession();
        return;
      }
      try {
        await adopt(token!);
      } catch {
        await clearSession();
        setApiSession(null);
      }
    },

    /** WorkOS AuthKit in the system browser, finished with a PKCE one-time code exchange. */
    signIn: async () => {
      set({ loading: true, error: null });
      try {
        const verifier = verifierFromRandomBytes(await Crypto.getRandomBytesAsync(128));
        const challenge = base64ToBase64Url(
          await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
            encoding: Crypto.CryptoEncoding.BASE64,
          }),
        );
        const { data } = await api.post<{ url: string }>('/auth/workos/mobile/start', { codeChallenge: challenge });
        if (!isTrustedAuthUrl(data.url)) throw new Error('Sign-in is unavailable right now.');

        const result = await WebBrowser.openAuthSessionAsync(data.url, APP_REDIRECT);
        if (result.type !== 'success') return; // user closed the browser
        const code = codeFromRedirect(result.url, APP_REDIRECT);
        if (!code) throw new Error('Sign-in did not complete. Please try again.');

        const exchange = await api.post<{ access_token: string }>('/auth/workos/mobile/exchange', {
          code,
          codeVerifier: verifier,
        });
        await saveToken(exchange.data.access_token);
        await adopt(exchange.data.access_token);
      } catch (e: any) {
        set({ error: e?.response ? 'Sign-in is unavailable right now. Please try again in a few minutes.' : e.message || errorMessage(e) });
      } finally {
        set({ loading: false });
      }
    },

    signOut: async () => {
      const token = get().token;
      setApiSession(null);
      set({ user: null, token: null });
      await clearSession();
      if (token) {
        api.post('/auth/logout', undefined, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      }
    },
  };
});
