/**
 * Signing in, from the client's side of it.
 *
 * The server is the only OpenID Connect client; a peer never sees the
 * provider. What a peer does is open one URL — the server's login page,
 * told where to send the answer — and receive one single-use code, which it
 * trades here for a `Login`: a token to put on the socket, the session id its
 * entries will carry, and who it is.
 *
 * Opening the URL is the app's job, because only the app knows what a URL
 * scheme it can be sent back to looks like: `expo-web-browser`'s
 * `openAuthSessionAsync` on a phone, `location.assign` in a browser. What is
 * general is everything else, which is this file.
 */

import type { Storage } from './storage';

/** A signed-in person, as the server knows them. */
export type Account = {
  /** The stable id: the provider's `sub`, or the name a dev server was given. */
  id: string;
  name: string;
  email: string;
};

/**
 * What a sign-in hands back. Keep it: the token is not shown twice, and it
 * is what `usePeer`'s `token` wants.
 */
export type Login = {
  /** Proves the session. Sent in every `Hello`; never put in a URL. */
  token: string;
  /** The session's id, which entries authored under it carry. */
  session: string;
  user: Account;
  /** When the token stops working, as milliseconds since the epoch. */
  expiresMs: number;
};

const base = (server: string): string => server.replace(/\/+$/, '');

/**
 * The URL to send a person to. `redirect` is where the code comes back —
 * the app's own scheme, `harken://auth`, on a phone — and `user` is honoured
 * only by a server in dev mode.
 */
export function loginUrl(server: string, redirect: string, user?: string): string {
  const url = `${base(server)}/auth/login?redirect=${encodeURIComponent(redirect)}`;
  return user ? `${url}&user=${encodeURIComponent(user)}` : url;
}

/**
 * The socket beside the login. A peer is told one address, `http://host:port`
 * or `https://host`, and derives the other, so a server moved behind TLS is
 * one setting and not two.
 */
export function socketUrl(server: string): string {
  const s = base(server);
  if (s.startsWith('https://')) return `wss://${s.slice(8)}/sync`;
  if (s.startsWith('http://')) return `ws://${s.slice(7)}/sync`;
  if (s.startsWith('ws://') || s.startsWith('wss://')) return `${s}/sync`;
  return `ws://${s}/sync`;
}

/** The code out of the URL a sign-in came back on, if it is one. */
export function codeOf(url: string): string | null {
  const query = url.split('#')[0]?.split('?')[1];
  if (!query) return null;
  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=');
    if (k === 'code' && v) return decodeURIComponent(v);
  }
  return null;
}

/** The code, for the login it stands for. Once. */
export async function exchange(server: string, code: string): Promise<Login> {
  const resp = await fetch(`${base(server)}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) throw new Error(`sign-in failed: ${await resp.text()}`);
  return fromWire(await resp.json());
}

/** Whether `token` still proves a login at `server`, and whose. */
export async function whoami(server: string, token: string): Promise<Login | null> {
  const resp = await fetch(`${base(server)}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 401) return null;
  if (!resp.ok) throw new Error(`cannot reach ${server}: ${resp.status}`);
  return fromWire(await resp.json());
}

/** End the login `token` proves. */
export async function logout(server: string, token: string): Promise<void> {
  await fetch(`${base(server)}/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** The server's JSON is `snake_case`; the rest of this package is not. */
function fromWire(raw: unknown): Login {
  const r = raw as {
    token: string;
    session: string;
    user: Account;
    expires_ms: number;
  };
  return {
    token: r.token,
    session: r.session,
    user: { id: r.user.id, name: r.user.name ?? '', email: r.user.email ?? '' },
    expiresMs: r.expires_ms,
  };
}

const slot = (server: string) => `petros.login.${base(server)}`;

/** The login this device has for `server`, kept across launches. */
export function recallLogin(storage: Storage, server: string): Login | null {
  const found = storage.get(slot(server));
  if (found === null) return null;
  try {
    const parsed = JSON.parse(found) as Login;
    return typeof parsed?.token === 'string' && typeof parsed?.user?.id === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Keep it. The token is a secret; the storage is whatever the app trusts. */
export function rememberLogin(storage: Storage, server: string, login: Login): void {
  storage.set(slot(server), JSON.stringify(login));
}

/** Signed out, or turned away for good. */
export function forgetLogin(storage: Storage, server: string): void {
  storage.remove(slot(server));
}
