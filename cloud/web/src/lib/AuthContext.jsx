/**
 * Authentication context for the Control Panel SPA.
 *
 * Provides `token`, `login`, `logout`, and a boolean `isAuthenticated`.
 * Token is persisted in localStorage via the helpers in `apiFetch.js`.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl } from './apiUrl';
import { getToken, setToken, clearToken } from './apiFetch';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => getToken());
  const navigate = useNavigate();

  const login = useCallback(async (email, password) => {
    const res = await fetch(apiUrl('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || data.message || 'Login failed');
    }

    const keyme_token = data.keyme_token;
    if (!keyme_token) {
      throw new Error('No token returned from login');
    }

    setToken(keyme_token);
    setTokenState(keyme_token);
    return data;
  }, []);

  const logout = useCallback(async () => {
    const currentToken = getToken();
    clearToken();
    setTokenState(null);

    // Best-effort server-side logout
    if (currentToken) {
      try {
        await fetch(apiUrl('/api/logout'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_token: currentToken }),
        });
      } catch {
        // Ignore errors — token is already cleared locally.
      }
    }

    navigate('/login');
  }, [navigate]);

  const value = useMemo(
    () => ({ token, isAuthenticated: !!token, login, logout }),
    [token, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
