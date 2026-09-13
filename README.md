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
- `loginUrl` / `exchange` / `whoami` / `logout` — signing in. The server is
  the only OpenID Connect client; a peer opens one URL and receives one
  single-use code, and `exchange` trades it for a `Login`: the token
  `usePeer` puts on the socket, the session its entries carry, and who it
  is. `recallLogin` / `rememberLogin` keep it. Opening the URL stays in the
  app — `expo-web-browser`'s `openAuthSessionAsync` on a phone — because only
  the app knows its own URL scheme.
- `socketUrl` — `/sync` beside the login, `wss` for `https`. A peer is told
  one address and derives the other.

A peer that the server turns away — an expired token, a revoked session —
stops reconnecting and says why in `denied`; a new `token` reconnects. What
it authored meanwhile is kept and offered then.

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

## Building an app for a phone

The nix half of this repository is how a Petros app reaches Android without
the network and without recompiling the world: `ubrn` built once from a
committed lockfile, the engine cross-compiled in two layers so a changed
mutation recompiles the app's crates and nothing else, and the Expo project's
gradle state carried between builds. It builds on
[expo.nix](https://github.com/k2on/expo.nix) and
[android.nix](https://github.com/k2on/android.nix), and an app needs only
this input to get all three:

```nix
inputs.petros-js = {
  url = "github:k2on/petros-js";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.petros.follows = "petros";
};

{ imports = [ inputs.petros-js.flakeModules.default ]; }

perSystem = { petrosJs, ... }:
  let app = petrosJs.mkApp { name = "myapp"; … }; in
  { packages = { inherit (app) apk gradleState engine deps; }; };
```

`mkApp` takes the app's files and hashes — its workspace, its narrowed
engine tree, the Expo project, the `ubrn` lockfile, `gradle-deps.json`, the
gradle version — and returns every derivation on the way, because each is
worth building alone when something is slow or broken. `harken` is the app
this was extracted from, and its `modules/android.nix` is the whole of what
an app has to say.

```
nix/lib/rust.nix    mkUbrn, stubSources, mkEngine
nix/lib/app.nix     mkApp
nix/default.nix     the non-flake entry point
modules/            flake-parts wiring; `_petros-js.nix` is the module an app gets
```

`nix/app` is the same as a flake-parts module: an app whose `flake.nix` is
`petros.lib.mkApp` imports it from the revision `package.json` pins and sets
`mobile.name`, its hashes and its EAS profiles, and the phone's packages,
`nix run` programs, generated files and `android` shell all follow. See
`nix/app/default.nix`.
