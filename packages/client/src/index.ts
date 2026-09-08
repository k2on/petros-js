/**
 * The TypeScript side of Petros: a socket, a pump, and a way to swap `apply`
 * on a running device.
 *
 * Nothing here knows what your domain is, and that is not an accident. `apply`
 * is compiled once, in Rust, and every peer runs that one artifact — two
 * implementations in two languages is two definitions of what a mutation
 * *means*, and the first time they disagree the replicas diverge silently with
 * neither side obviously at fault.
 */

export { asNumber, messageOf, type Count, type PetrosClient, type Rejection } from './client';
export { Link, type LinkEvents } from './link';
export { decodeBase64, installMutators } from './mutators';
