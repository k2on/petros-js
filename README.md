# petros-js

The TypeScript side of [Petros](../petros): the socket, the pump, and the
hot-swap channel that carries a domain to a running device.

There is deliberately no domain logic here, and there never will be. `apply`
lives in Rust and is compiled once; two implementations of it in two languages
is two definitions of what a mutation *means*, and the first time they disagree
the replicas diverge silently with neither side obviously at fault.

What is left for TypeScript is a socket and a clock.

## `@petros/client`

- `Link` — a `WebSocket` that carries encoded frames in and out of a Petros
  client, holding early sends until it opens.
- `pump` — a sans-io client has to be driven by someone; this is that someone.
- `installMutators` — base64 in, a running `apply` out.
- `usePeer` — the React binding, generic over your client and your query.
- `recallServer` / `rememberServer` — which server a peer joined, kept across
  launches, over a `Storage` the app supplies. "Working alone" is one of the
  answers rather than the absence of one.

A session's `server` is nullable and can be changed while it runs, so a peer can
be pointed somewhere else, or nowhere, without reopening its database.

Depend on it by git while it is unpublished:

```json
"@petros/client": "github:k2on/petros-js#<sha>"
```

Pinned to a commit rather than a branch, so a build a month from now installs
what this one did.

This repository *is* the package — no workspace, no `packages/` — because a git
dependency installs a repository root and neither npm nor bun can point at a
subdirectory inside one. A `file:` path would work on a laptop and fail in any
build container that checks out one repository, which is where the last one was
caught.
