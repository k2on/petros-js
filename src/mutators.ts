/**
 * Carrying the domain to the device.
 *
 * The module arrives as a base64 string in a generated `.ts`, because Metro's
 * fast refresh moves *modules*, not assets — so the channel already pushing
 * your component edits pushes `apply`. No asset pipeline, no fetch, no dev
 * server of our own. The only work on this side is a base64 decode and a call
 * into wasmi, which is why a saved Rust file reaches a running phone in about
 * a third of a second.
 */

import { asNumber, messageOf, type PetrosClient } from './client';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Hermes has `atob`, but not on every React Native version worth supporting. */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Install a module. Returns the generation, which moves on every swap.
 *
 * A module that will not load leaves the previous one running, which is the
 * right failure: you keep working while you fix the Rust. That is why this
 * returns a result rather than throwing — a hot reload is not a place to
 * unmount a tree.
 */
export function installMutators(
  client: PetrosClient,
  base64: string,
): { generation: number; error?: string } {
  try {
    const bytes = decodeBase64(base64);
    return { generation: asNumber(client.loadMutators(bytes.buffer as ArrayBuffer)) };
  } catch (e) {
    return { generation: -1, error: messageOf(e) };
  }
}
