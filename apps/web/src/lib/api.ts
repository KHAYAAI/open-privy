import axios, { AxiosError, AxiosInstance } from 'axios';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * The session lives in the backend's httpOnly `op_session` cookie, so no
 * token is ever readable by page scripts (an XSS bug cannot steal it).
 * Every request carries X-CSRF-Token, which the backend requires on
 * cookie-authenticated writes; other sites cannot add it without passing CORS.
 */
export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  timeout: 20_000,
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': '1',
  },
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const onAuthPage = typeof window !== 'undefined' && window.location.pathname.startsWith('/auth/');
    const isSessionProbe = error.config?.url === '/auth/me';
    if (error.response?.status === 401 && !onAuthPage && !isSessionProbe && typeof window !== 'undefined') {
      window.location.assign('/auth/login?expired=1');
    }
    return Promise.reject(error);
  },
);

/** A user-facing message from an API error, never a stack trace or raw object. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as AxiosError<{ message?: string | string[] }>;
  if (!e?.response) {
    return e?.code === 'ECONNABORTED' ? 'The server took too long to respond. Please try again.' : 'Cannot reach the server. Check your connection.';
  }
  const m = e.response.data?.message;
  if (Array.isArray(m)) return m.join('. ');
  if (typeof m === 'string' && m.length < 300) return m;
  return fallback;
}

export default api;
