/**
 * The React binding.
 *
 * Generic over your client and your query, because the engine's entry points
 * are generic and the queries are yours. Nothing below decides anything about
 * a domain: it borrows a [`session`], drives nothing itself, and re-runs the
 * query you gave it when something changed.
 *
 * The database and the socket live in the session, not in this hook. Unmounting
 * a screen does not close them — see `session.ts` for the measurement that made
 * that necessary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { asNumber, messageOf, type PetrosClient } from './client';
import { held, session as openSession, type Scratch } from './session';

const now = (): number =>
  typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();

export type PeerState<T> = {
  /** Whatever your query returned, last time anything changed. */
  data: T | null;
  cursor: number;
  pending: number;
  online: boolean;
  /** The last thing worth saying out loud: an error, a rejection, a status. */
  note: string;
  /** Which mutator module is running. Moves on every hot swap. */
  mutators: number;
  /** Where this peer is pointed, or null when it is working alone. */
  server: string | null;
  /**
   * How long the last mutation took inside Rust, in milliseconds: the engine,
   * the module and the SQL, but not this render. The number to look at before
   * believing the device is the slow part.
   */
  lastMutationMs: number | null;
};

export type UsePeerOptions<C extends PetrosClient, T> = {
  /** Open the database. Called once per `key`, ever. */
  open: () => C;
  /** What makes two peers different — an actor name, usually. */
  key: string;
  /** Where to point it. `null` is a peer working alone, and is a choice. */
  server: string | null;
  /**
   * Your read model. Re-run whenever anything moved, never on a quiet tick.
   *
   * The second argument is per-session [`Scratch`], and a query reading a
   * *maintained* view needs it: the view reports what moved since it was last
   * asked, so whatever is being moved has to outlive the component asking.
   */
  query: (client: C, scratch: Scratch) => T;
  /**
   * Install the module this bundle carries, and reinstall when it changes.
   * Both stay in the app: Metro needs a static path to the generated file, so
   * only the app can name it.
   */
  install?: (client: C) => string;
  watch?: (client: C, onSwap: (note: string) => void) => () => void;
};

export type Peer<C extends PetrosClient, T> = PeerState<T> & {
  /** Run something against the client and render the result immediately. */
  run: (f: (client: C) => void) => void;
  toggleLink: () => void;
  /** Reconnect now. Wire this to `AppState` becoming active. */
  reconnect: () => void;
  /** Point this peer somewhere else, or nowhere, without remounting. */
  setServer: (next: string | null) => void;
};

export function usePeer<C extends PetrosClient, T>(
  options: UsePeerOptions<C, T>,
): Peer<C, T> {
  const { open, key, server, query, install, watch } = options;
  const latest = useRef({ query, open, install, watch });
  latest.current = { query, open, install, watch };

  const [state, setState] = useState<PeerState<T>>({
    data: null,
    cursor: 0,
    pending: 0,
    online: false,
    note: '',
    mutators: 0,
    lastMutationMs: null,
    server,
  });

  // Borrowed, not created. If this key has been seen before, the database is
  // already open, the socket is already up, and whatever arrived while nothing
  // was mounted is already applied.
  const peer = useMemo(() => {
    try {
      return openSession<C>(key, () => latest.current.open(), server);
    } catch (e) {
      setState((s) => ({ ...s, note: `could not open the database: ${messageOf(e)}` }));
      return null;
    }
    // Keyed on the actor alone. A different server is not a different peer —
    // same database, same pending edits, somewhere else to offer them — so it
    // is applied to the live session below rather than reopening anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Where it is pointed can change while it runs: a URL typed in, or the choice
  // to work alone. Without this the first server a process ever saw was the
  // only one it would use, and a corrected address did nothing until a restart.
  useEffect(() => {
    peer?.setServer(server);
  }, [peer, server]);

  const snapshot = useCallback(() => {
    if (!peer) return;
    const client = peer.client;
    setState({
      data: latest.current.query(client, peer.scratch),
      cursor: asNumber(client.cursor()),
      pending: client.pendingLen(),
      online: peer.connected(),
      note: peer.note,
      mutators: asNumber(client.mutatorsGeneration()),
      lastMutationMs: peer.lastMutationMs,
      server: peer.server,
    });
  }, [peer]);

  // The module arrives as a file rather than being linked in, so it has to be
  // installed before the first mutation — and reinstalled whenever the bundler
  // replaces it. That second line is the whole hot-reload story: the database,
  // the socket and the React tree all survive it, and only `apply` changes
  // underneath them.
  useEffect(() => {
    if (!peer) return;
    peer.note = latest.current.install?.(peer.client) ?? peer.note;
    const unwatch = latest.current.watch?.(peer.client, (note) => {
      peer.note = note;
      peer.changed();
    });
    return unwatch;
  }, [peer]);

  // Render when the session says something moved, and once on mount so a
  // returning screen shows what arrived while it was gone.
  useEffect(() => {
    if (!peer) return;
    snapshot();
    return peer.subscribe(snapshot);
  }, [peer, snapshot]);

  const run = useCallback(
    (f: (client: C) => void) => {
      if (!peer) return;
      const started = now();
      try {
        f(peer.client);
      } catch (e) {
        // A mutation the app itself refuses never reaches the pending queue.
        peer.note = messageOf(e);
      }
      peer.lastMutationMs = now() - started;
      // Render what just happened rather than waiting for the pump. Letting the
      // tick pick it up put 0-50ms between a tap and the screen moving, which
      // on its own is more than the whole engine costs for a typical mutation.
      snapshot();
    },
    [peer, snapshot],
  );

  return useMemo(
    () => ({
      ...state,
      run,
      toggleLink: () => peer?.toggleLink(),
      reconnect: () => peer?.reconnect(),
      setServer: (next: string | null) => peer?.setServer(next),
    }),
    [state, run, peer],
  );
}
