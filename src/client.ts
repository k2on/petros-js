/**
 * What `@petros/client` needs a Petros client to be.
 *
 * Structural on purpose. A UniFFI-generated client satisfies this without
 * knowing this file exists, and nothing here names your domain — `mutate` takes
 * a verb and a JSON object because the engine genuinely does not know what
 * verbs exist, which is what lets a new one ship without a native build. The
 * types that put the compiler's opinion back are generated from the same
 * declaration the module dispatches on; see `petros-codegen`.
 */

/** A mutation the server refused: a verdict every replica would have reached. */
export type Rejection = { id: string; reason: string };

/** u64 crosses UniFFI as a bigint; u32 as a number. Tolerate both. */
export type Count = bigint | number;

export interface PetrosClient {
  /** Drain the outbox as encoded frames, ready to put on a socket. */
  takeOutgoing(): ArrayBuffer[];
  /** Hand one frame from the server to the engine. */
  recv(frame: ArrayBuffer): void;
  /** Ask for everything since our cursor and re-offer everything pending. */
  connected(): void;
  /**
   * Nothing is carrying frames any more: a dropped socket, or a peer working
   * deliberately alone. The engine drops its outbox and stops filling it.
   *
   * Optional because an engine older than this method still works — the
   * transport just goes back to throwing frames on the floor itself, which is
   * what everything did before the engine had a word for it.
   */
  disconnected?(): void;
  /** Whether the engine believes anything is carrying its frames. */
  linked?(): boolean;
  /** How much of the server's log has been applied. */
  cursor(): Count;
  /** How many of our own mutations no server has confirmed yet. */
  pendingLen(): number;
  takeRejections(): Rejection[];
  /** Install a mutator module, replacing whatever was running. */
  loadMutators(wasm: ArrayBuffer): Count;
  mutatorsGeneration(): Count;
  mutate(kind: string, args: string): void;
}

export const asNumber = (n: Count): number => Number(n);

export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
