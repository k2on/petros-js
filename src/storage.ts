/**
 * Remembering where a peer was pointed.
 *
 * A peer that forgets its server on every launch is not offline-first, it is
 * amnesiac: you retype a LAN address before you can look at your own data. So
 * the choice is remembered — and "no server" is one of the choices, not the
 * absence of one.
 *
 * The bytes are the app's problem. There is no storage this library could pick
 * that is right everywhere: a browser has `localStorage`, React Native has
 * neither that nor anything synchronous without a native module, and a test
 * wants a `Map`. What is general is *what* is stored and how the three states
 * are told apart, which is this file; the app passes in somewhere to put it.
 */

/**
 * Somewhere to keep a string.
 *
 * Synchronous on purpose: the connect screen needs an initial value while it is
 * rendering, and an async read means one frame of the wrong answer and a
 * flicker as it corrects itself. Every platform can do this — `localStorage`,
 * a file read, an in-memory `Map`.
 */
export type Storage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

/** A `Storage` over a plain `Map`. For tests, and for a platform still deciding. */
export function memoryStorage(seed?: Iterable<readonly [string, string]>): Storage {
  const map = new Map(seed ?? []);
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

const slot = (key: string) => `petros.server.${key}`;

/**
 * The server this peer joined last time.
 *
 * Three answers, and the difference between the last two is the whole point:
 *
 * - a URL — join it again
 * - `null` — it chose to work alone; do not connect, and do not ask again
 * - `undefined` — it has never been asked, so the app should ask
 *
 * An empty string is how "alone" is stored, because a storage holds strings and
 * "absent" is already taken by "never asked".
 */
export function recallServer(storage: Storage, key: string): string | null | undefined {
  const found = storage.get(slot(key));
  if (found === null) return undefined;
  return found === '' ? null : found;
}

/** Remember it, `null` for a peer that chose to work alone. */
export function rememberServer(storage: Storage, key: string, server: string | null): void {
  storage.set(slot(key), server ?? '');
}

/** Forget, so the next launch asks again. */
export function forgetServer(storage: Storage, key: string): void {
  storage.remove(slot(key));
}
