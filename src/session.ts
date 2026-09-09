/**
 * One live peer, outliving the components that look at it.
 *
 * A React component that opens the database in an effect closes it again on
 * unmount, so navigating away and back pays for the whole thing twice. That is
 * not free: opening a peer is 0.34ms plus about 0.55ms for every mutation this
 * peer has pending, because the rebase replays them — measured at 113ms for a
 * peer holding 200 offline edits, and paid on every remount. The socket goes
 * with it, so the app also reconnects and re-syncs.
 *
 * So the session lives here, in a module-level registry, and the hook borrows
 * it. It keeps pumping while nothing is mounted, which is what makes coming
 * back to a screen instant rather than a reopen.
 *
 * The database is never closed. One connection per actor for the life of the
 * process is the same assumption a desktop peer makes.
 */

import { messageOf, type PetrosClient } from './client';
import { Link } from './link';

/** How often the transport is pumped. Small enough to feel live. */
const TICK_MS = 50;

/** Backoff for an unattended reconnect: quick at first, then patient. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export type Session<C extends PetrosClient> = {
  readonly client: C;
  readonly link: Link;
  /** The last thing worth saying out loud. */
  note: string;
  /** How long the last mutation took inside Rust. */
  lastMutationMs: number | null;
  /** Something changed; anything watching should recompute. */
  dirty: boolean;
  subscribe(listener: () => void): () => void;
  changed(): void;
  /** Reconnect now — after the OS suspended the app, say. */
  reconnect(): void;
  connected(): boolean;
  toggleLink(): void;
};

const sessions = new Map<string, Session<PetrosClient>>();

/**
 * The session for `key`, opening one if this is the first ask.
 *
 * `key` is whatever makes two peers different — an actor name, usually. Two
 * names on one device are two peers with two databases, exactly as `--user` is
 * on the desktop.
 */
export function session<C extends PetrosClient>(
  key: string,
  open: () => C,
  server: string,
): Session<C> {
  const existing = sessions.get(key);
  if (existing) return existing as Session<C>;

  const listeners = new Set<() => void>();
  const client = open();
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let wanted = true;

  const self: Session<C> = {
    client,
    link: null as unknown as Link,
    note: '',
    lastMutationMs: null,
    dirty: true,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changed() {
      self.dirty = true;
      for (const listener of listeners) listener();
    },
    reconnect() {
      wanted = true;
      if (!self.link.connected) self.link.connect(server);
    },
    connected() {
      return self.link.connected;
    },
    toggleLink() {
      if (self.link.connected) {
        wanted = false;
        if (retry) clearTimeout(retry);
        retry = null;
        self.link.disconnect('gone offline — edits pile up locally');
      } else {
        attempt = 0;
        self.reconnect();
      }
    },
  };

  const link = new Link(client, {
    onNote: (note) => {
      self.note = note;
    },
    onChange: () => self.changed(),
  });
  (self as { link: Link }).link = link;

  // Reconnect without being asked. The OS suspends a backgrounded app and the
  // socket dies with it; the engine treats that as being offline, so coming
  // back is a `Hello` and whatever the log gained meanwhile.
  const schedule = () => {
    if (!wanted || link.connected || retry) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      if (wanted && !link.connected) link.connect(server);
    }, wait);
  };

  link.connect(server);

  // The pump belongs to the session rather than to a component, so it keeps
  // running with nothing mounted. That is the whole point: a screen you come
  // back to is already up to date.
  setInterval(() => {
    try {
      if (link.pump()) self.changed();
    } catch (e) {
      self.note = messageOf(e);
      self.changed();
    }
    if (link.connected) attempt = 0;
    else schedule();
  }, TICK_MS);

  sessions.set(key, self as Session<PetrosClient>);
  return self;
}

/**
 * Close a peer and forget it. Rarely wanted — a signed-out account, a test.
 *
 * Not called on unmount, which is the entire reason this module exists.
 */
export function endSession(key: string): void {
  const found = sessions.get(key);
  if (!found) return;
  found.link.disconnect();
  sessions.delete(key);
  (found.client as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
}
