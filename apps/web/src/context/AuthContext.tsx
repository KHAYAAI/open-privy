import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { isTrustedAuthUrl } from '@/lib/validation';

export interface User {
  id: string;
  email: string;
  username?: string;
  emailVerified?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (organizationId?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<User>('/auth/me');
      setUser(data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Sends the browser to WorkOS AuthKit (sign in or sign up, SSO, social, MFA). */
  const login = async (organizationId?: string) => {
    let url: string;
    try {
      const { data } = await api.get<{ url: string }>('/auth/workos/authorize', {
        params: organizationId ? { organization_id: organizationId } : undefined,
      });
      url = data.url;
    } catch {
      // Server details (e.g. missing configuration) are not for end users.
      throw new Error('Sign-in is unavailable right now. Please try again in a few minutes.');
    }
    if (!isTrustedAuthUrl(url)) {
      throw new Error('Sign-in is unavailable right now.');
    }
    window.location.assign(url);
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      window.location.assign('/auth/login');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
