// Session state: which wallet is signed in and what role it has on-chain.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, api, setToken } from "./lib/api";
import { connectWallet, signInWithEthereum } from "./lib/chain";
import type { Role } from "./lib/format";

export type Session = {
  wallet: string;
  role: Role | null;
  profile: { org_name: string; contact_email: string } | null;
  latestRequest: { id: number; status: string; requested_role: Role; created_at: string } | null;
};

type AuthState = {
  session: Session | null;
  loading: boolean;
  signIn: () => Promise<Session>;
  signOut: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);
const STORAGE_KEY = "coldchainsg.token";

// The token only lives for this browser tab; storage can be unavailable (e.g. private mode).
const storage = {
  get: () => {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (value: string | null) => {
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    setToken(null);
    storage.set(null);
    setSession(null);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api<Session>("identity", "/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else throw err;
    }
  }, [signOut]);

  // Restore a session from this tab, if any.
  useEffect(() => {
    const saved = storage.get();
    if (!saved) {
      setLoading(false);
      return;
    }
    setToken(saved);
    loadSession()
      .catch(() => signOut())
      .finally(() => setLoading(false));
  }, [loadSession, signOut]);

  // Switching accounts in MetaMask signs you out, so actions are never sent from the wrong wallet.
  useEffect(() => {
    const onAccounts = (accounts: string[]) => {
      if (session && accounts[0]?.toLowerCase() !== session.wallet.toLowerCase()) signOut();
    };
    window.ethereum?.on?.("accountsChanged", onAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", onAccounts);
  }, [session, signOut]);

  const signIn = useCallback(async () => {
    const address = await connectWallet();
    const { token } = await signInWithEthereum(address);
    setToken(token);
    storage.set(token);
    const me = await api<Session>("identity", "/me");
    setSession(me);
    return me;
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, signIn, signOut, refresh: loadSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
