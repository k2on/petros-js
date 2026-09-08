# petros-js

The TypeScript side of [Petros](../petros): the socket, the pump, and the
hot-swap channel that carries a domain to a running device.

There is deliberately no domain logic here, and there never will be. `apply`
lives in Rust and is compiled once; two implementations of it in two languages
is two definitions of what a mutation *means*, and the first time they disagree
the replicas diverge silently with neither side obviously at fault.

What is left for TypeScript is a socket and a clock.

## packages/client — `@petros/client`

- `Link` — a `WebSocket` that carries encoded frames in and out of a Petros
  client, holding early sends until it opens.
- `pump` — a sans-io client has to be driven by someone; this is that someone.
- `installMutators` — base64 in, a running `apply` out.
- `usePeer` — the React binding, generic over your client and your query.

Depend on it by path while it is unpublished:

```json
"@petros/client": "file:../../petros-js/packages/client"
```

`file:` and not `link:` — in bun, `link:` means a package registered with
`bun link`, not a path, and fails with `FileNotFound`.
