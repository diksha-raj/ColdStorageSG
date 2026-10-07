import { useCallback, useEffect, useRef, useState } from "react";
import { type Service, api } from "./api";
import { friendlyError } from "./chain";

/**
 * Loads data from a service. With `pollMs`, it refreshes in the background so dashboards
 * update live during the demo (e.g. when another participant accepts a handover).
 */
export function useApi<T>(service: Service, path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(service, path));
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [service, path]);

  useEffect(() => {
    setLoading(true);
    load();
    if (!pollMs) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  return { data, error, loading, reload: load };
}

/**
 * Wraps a MetaMask action (or any async action) with busy / error / success state.
 * `run` returns the action's result, or undefined if it failed.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const run = useCallback(async <R,>(action: () => Promise<R>, successMessage?: string): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await action();
      if (mounted.current && successMessage) setSuccess(successMessage);
      return result;
    } catch (err) {
      if (mounted.current) setError(friendlyError(err));
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { run, busy, error, success, clear: () => (setError(null), setSuccess(null)) };
}
