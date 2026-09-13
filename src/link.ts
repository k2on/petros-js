/**
 * The socket, and the loop that drives it.
 *
 * `petros::client` is sans-io — it owns no socket, no runtime and no thread —
 * so somebody has to carry bytes between it and the network. That somebody is
 * about a hundred lines, which is the whole argument for the engine being
 * sans-io in the first place: this file is replaceable and the engine is not.
 */

import { messageOf, type PetrosClient } from './client';

export type LinkEvents = {
  /** Something worth showing a person: connected, dropped, refused. */
  onNote?: (note: string) => void;
  /** Anything happened that a view should be recomputed for. */
  onChange?: () => void;
  /**
   * The server turned this peer away: not signed in, or not as who it
   * claims. The socket is closed behind it and nothing reconnects until a
   * new token is set — retrying a refused login would only be refused again.
   */
  onDenied?: (reason: string) => void;
};

/**
 * A `WebSocket` carrying encoded Petros frames.
 *
 * Two wrinkles worth keeping. A `WebSocket` throws on send until it is open,
 * and the first thing a client says is its `Hello` — so early frames are held
 * and flushed on open. And the engine is told when there is no longer a socket:
 * it keeps its own outbox empty from then on, which is a thing only it can do,
 * since a transport can decline to *read* frames but cannot stop them being
 * written. Reconnecting re-offers everything still pending, and the server
 * dedupes what it has already seen.
 */
export class Link {
  private socket: WebSocket | null = null;
  private open = false;
  private backlog: ArrayBuffer[] = [];
  private token: string | undefined;
  private denied = false;

  constructor(
    private readonly client: PetrosClient,
    private readonly events: LinkEvents = {},
  ) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * What to prove the login with. Handed to the engine, which puts it in
   * every `Hello` — so a token set while connected takes effect on the next
   * connect, and the caller reconnects to use it now.
   */
  setToken(token: string | undefined): void {
    this.token = token;
    this.denied = false;
    this.client.setToken?.(token);
  }

  connect(url: string): void {
    if (this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      this.note(`cannot reach ${url} (${messageOf(e)}) — working offline`);
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.open = false;

    socket.onopen = () => {
      this.open = true;
      for (const frame of this.backlog) socket.send(frame);
      this.backlog = [];
      this.note(`connected to ${url}`);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        // Straight into Rust. TypeScript never looks inside a frame.
        this.client.recv(event.data);
      } catch (e) {
        this.note(messageOf(e));
      }
      // A denial is the last frame on this socket. Say so before the close
      // that follows it, which would otherwise read as a dropped link.
      const denial = this.client.takeDenial?.();
      if (denial !== undefined) {
        this.denied = true;
        this.events.onDenied?.(denial);
        this.disconnect(`signed out: ${denial}`);
        return;
      }
      this.events.onChange?.();
    };
    socket.onerror = () => {
      if (this.socket === socket) this.disconnect(`cannot reach ${url} — working offline`);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.disconnect('the link dropped');
    };

    try {
      this.client.setToken?.(this.token);
      this.client.connected();
    } catch (e) {
      this.note(messageOf(e));
    }
    this.events.onChange?.();
  }

  /** Whether the last connection ended in the server turning this peer away. */
  get wasDenied(): boolean {
    return this.denied;
  }

  disconnect(note = ''): void {
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.backlog = [];
    // The engine stops queueing rather than us stopping collecting.
    this.client.disconnected?.();
    if (note) this.note(note);
    else this.events.onChange?.();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Closing a socket that never opened is not worth reporting.
    }
  }

  /**
   * One turn of the crank: everything the client wants to send goes out, and
   * anything it refused comes back as a note.
   *
   * Returns whether anything happened, so a caller can skip recomputing a view
   * for a tick where nothing did.
   */
  pump(): boolean {
    let changed = false;
    try {
      for (const frame of this.client.takeOutgoing()) {
        // Belt and braces: an engine that predates `disconnected` still hands
        // frames over with nowhere to put them.
        if (!this.socket) continue;
        if (this.open) this.socket.send(frame);
        else this.backlog.push(frame);
      }
      for (const rejection of this.client.takeRejections()) {
        this.note(`the server refused a change: ${rejection.reason}`);
        changed = true;
      }
    } catch (e) {
      this.note(messageOf(e));
      changed = true;
    }
    return changed;
  }

  private note(note: string): void {
    this.events.onNote?.(note);
    this.events.onChange?.();
  }
}
