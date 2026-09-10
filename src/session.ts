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
 *
 * A session also owns *where* it is pointed. `server` is nullable, and null is
 * not a degraded connected: it is a peer deliberately working alone, with no
 * socket, no connection attempt and no backoff. That is the same state the
 * engine is in between reconnects, so nothing downstream needs a second notion
 * of offline — but it has to be reachable without lying about a URL first.
 */

import { messageOf, type PetrosClient } from './client';
import { Link } from './link';

/** How often the transport is pumped. Small enough to feel live. */
const TICK_MS = 50;

/** Backoff for an unattended reconnect: quick at first, then patient. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

/**
 * Whatever a query accumulates between calls.
 *
 * A maintained view reports what *moved*, so its reader has to keep the thing
 * being moved. That reader is usually a component, and a component is the wrong
 * lifetime: the view's idea of what the reader has already seen lives here, in
 * the session, so a list spliced from its patches has to live here too. Held in
 * a ref instead, it starts empty on the next mount while the view goes on
 * reporting deltas against a list nobody has — and the screen shows nothing.
 */
export type Scratch = Map<string, unknown>;

/** The slot named `name`, created on first ask. */
export function held<T>(scratch: Scratch, name: string, init: () => T): T {
  if (!scratch.has(name)) scratch.set(name, init());
  return scratch.get(name) as T;
}

export type Session<C extends PetrosClient> = {
  readonly client: C;
  readonly link: Link;
  /** Where this peer is pointed, or null when it is working alone. */
  readonly server: string | null;
  /** State that outlives the components reading it. See [`Scratch`]. */
  readonly scratch: Scratch;
  /** Point this peer somewhere else, or nowhere. Takes effect now. */
  setServer(next: string | null): void;
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
  server: string | null,
): Session<C> {
  const existing = sessions.get(key);
  if (existing) return existing as Session<C>;

  const listeners = new Set<() => void>();
  const client = open();
  const scratch: Scratch = new Map();
  let target = server;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let wanted = target !== null;

  const stopRetrying = () => {
    if (retry) clearTimeout(retry);
    retry = null;
  };

  const self: Session<C> = {
    client,
    link: null as unknown as Link,
    scratch,
    get server() {
      return target;
    },
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
      if (target === null) return;
      wanted = true;
      if (!self.link.connected) self.link.connect(target);
    },
    connected() {
      return self.link.connected;
    },
    setServer(next) {
      if (next === target) return;
      target = next;
      attempt = 0;
      stopRetrying();
      // Disconnect quietly: the note that matters is the one about where this
      // peer is now, not that it left where it was.
      self.link.disconnect();
      if (next === null) {
        wanted = false;
        self.note = 'working alone — edits are kept and offered when you link up';
        self.changed();
        return;
      }
      wanted = true;
      self.link.connect(next);
    },
    toggleLink() {
      if (self.link.connected) {
        wanted = false;
        stopRetrying();
        self.link.disconnect('gone offline — edits pile up locally');
      } else if (target === null) {
        // Nothing to toggle back to. Saying so beats a silent no-op.
        self.note = 'no server to link up to — enter one to sync';
        self.changed();
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
    if (!wanted || target === null || link.connected || retry) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      if (wanted && target !== null && !link.connected) link.connect(target);
    }, wait);
  };

  if (target !== null) link.connect(target);

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
