/**
 * The React binding.
 *
 * Generic over your client and your query, because the engine's entry points
 * are generic and the queries are yours. Nothing below decides anything about
 * a domain: it opens a database, drives a socket, and re-runs the query you
 * gave it when something changed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { asNumber, messageOf, type PetrosClient } from './client';
import { Link } from './link';

/** How often the transport is pumped. Small enough to feel live. */
const TICK_MS = 50;

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
  /**
   * How long the last mutation took inside Rust, in milliseconds: the engine,
   * the module and the SQL, but not this render. The number to look at before
   * believing the device is the slow part.
   */
  lastMutationMs: number | null;
};

export type UsePeerOptions<C extends PetrosClient, T> = {
  /** Open the database. Called once per `key`. */
  open: () => C;
  /** Re-opened when this changes — one database per actor, say. */
  key: string;
  server: string;
  /** Your read model. Re-run whenever anything moved, and never on a quiet tick. */
  query: (client: C) => T;
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
};

export function usePeer<C extends PetrosClient, T>(
  options: UsePeerOptions<C, T>,
): Peer<C, T> {
  const { open, key, server, query, install, watch } = options;
  const clientRef = useRef<C | null>(null);
  const linkRef = useRef<Link | null>(null);
  const noteRef = useRef('');
  const dirtyRef = useRef(true);
  const lastMsRef = useRef<number | null>(null);
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
  });

  const snapshot = useCallback((client: C) => {
    setState({
      data: latest.current.query(client),
      cursor: asNumber(client.cursor()),
      pending: client.pendingLen(),
      online: linkRef.current?.connected ?? false,
      note: noteRef.current,
      mutators: asNumber(client.mutatorsGeneration()),
      lastMutationMs: lastMsRef.current,
    });
  }, []);

  useEffect(() => {
    let client: C;
    try {
      client = latest.current.open();
    } catch (e) {
      noteRef.current = `could not open the database: ${messageOf(e)}`;
      setState((s) => ({ ...s, note: noteRef.current }));
      return;
    }
    clientRef.current = client;

    // The domain arrives as a module rather than being linked in, so it has to
    // be installed before the first mutation — and reinstalled whenever the
    // bundler replaces it. That second line is the whole hot-reload story: the
    // database, the socket and the React tree all survive it, and only `apply`
    // changes underneath them.
    noteRef.current = latest.current.install?.(client) ?? '';
    const unwatch = latest.current.watch?.(client, (note) => {
      noteRef.current = note;
      dirtyRef.current = true;
    });

    const link = new Link(client, {
      onNote: (note) => {
        noteRef.current = note;
      },
      onChange: () => {
        dirtyRef.current = true;
      },
    });
    linkRef.current = link;
    link.connect(server);

    return () => {
      unwatch?.();
      link.disconnect();
      linkRef.current = null;
      clientRef.current = null;
      // The Rust object is reference counted; let go of it explicitly rather
      // than waiting for whenever the JS engine gets around to it.
      (client as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    };
    // `server` is fixed for the life of a screen; reopening on it would drop
    // the database with the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The pump. A sans-io client has to be driven by someone.
  useEffect(() => {
    const id = setInterval(() => {
      const client = clientRef.current;
      if (!client) return;
      if (linkRef.current?.pump()) dirtyRef.current = true;
      // Re-reading is the expensive part of a frame, so it waits for a reason.
      // An idle tick costs one `takeOutgoing` that returns nothing.
      if (dirtyRef.current) {
        dirtyRef.current = false;
        snapshot(client);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [snapshot]);

  const run = useCallback(
    (f: (client: C) => void) => {
      const client = clientRef.current;
      if (!client) return;
      const started = now();
      try {
        f(client);
      } catch (e) {
        // A mutation the app itself refuses never reaches the pending queue.
        noteRef.current = messageOf(e);
      }
      lastMsRef.current = now() - started;
      // Render what just happened rather than waiting for the pump. Letting the
      // tick pick it up put 0-50ms between a tap and the screen moving, which
      // on its own is more than the whole engine costs for a typical mutation.
      dirtyRef.current = false;
      snapshot(client);
    },
    [snapshot],
  );

  return useMemo(
    () => ({
      ...state,
      run,
      toggleLink: () => {
        const link = linkRef.current;
        if (!link) return;
        if (link.connected) link.disconnect('gone offline — edits pile up locally');
        else link.connect(server);
        dirtyRef.current = true;
      },
    }),
    [state, run, server],
  );
}
