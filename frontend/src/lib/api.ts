// Calls the five backend services directly (no API gateway). The session token comes from the
// Identity Service after Sign-In with Ethereum and is accepted by every service.

const URLS = {
  identity: import.meta.env.VITE_IDENTITY_URL ?? "http://localhost:4001",
  custody: import.meta.env.VITE_CUSTODY_URL ?? "http://localhost:4002",
  oracle: import.meta.env.VITE_ORACLE_URL ?? "http://localhost:4003",
  certificate: import.meta.env.VITE_CERTIFICATE_URL ?? "http://localhost:4004",
  gateway: import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:4005", // the sensor gateway
};

export type Service = keyof typeof URLS;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
export const setToken = (t: string | null) => (token = t);

export function serviceUrl(service: Service, path: string) {
  return URLS[service] + path;
}

export async function api<T = any>(
  service: Service,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(serviceUrl(service, path), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

