import axios, { AxiosError, AxiosInstance } from 'axios';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

let currentToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** The token is held in memory after unlock, so requests never re-trigger the biometric prompt. */
export function setApiSession(token: string | null, handleUnauthorized?: () => void) {
  currentToken = token;
  if (handleUnauthorized) onUnauthorized = handleUnauthorized;
}

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  if (currentToken) config.headers.Authorization = `Bearer ${currentToken}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    if (error.response?.status === 401 && currentToken) onUnauthorized?.();
    return Promise.reject(error);
  },
);

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as AxiosError<{ message?: string | string[] }>;
  if (!e?.response) return 'Cannot reach OpenPrivy. Check your connection.';
  const m = e.response.data?.message;
  if (Array.isArray(m)) return m.join('. ');
  if (typeof m === 'string' && m.length < 300) return m;
  return fallback;
}
