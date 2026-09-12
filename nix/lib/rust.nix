# A Petros app's Rust half, cross-compiled for Android with its bindings.
#
# `uniffi-bindgen-react-native` — `ubrn` — builds the crate for each ABI with
# `cargo-ndk` and writes the turbo module around it: the C++ adapter, the
# TypeScript, the `build.gradle`. What is here is how to do that without the
# network and without paying for the dependency graph twice.
{ pkgs, android, petros }:
let
  inherit (pkgs) lib;
in
rec {
  # The `ubrn` command, built once.
  #
  # `node_modules/.bin/ubrn` is a shim that runs `cargo run` against a crate
  # inside `node_modules`, so the first call in a fresh tree compiles a CLI from
  # source — and in a builder every call is the first call. Built here it is a
  # binary that answers in milliseconds, and it changes only when the lockfile
  # that pins it does.
  mkUbrn =
    { toolchain
    , nodeModules
      # A lockfile for the generator. It does not ship one — the npm package is
      # the built CLI plus its Rust sources, and `cargo` is expected to resolve
      # on the machine that runs it. So the app commits one and passes it here,
      # which is what makes this build pinned rather than merely offline.
      #
      # `node_modules/uniffi-bindgen-react-native/Cargo.lock` is not this
      # file: cargo writes one there whenever it runs under an app's tree, and
      # it comes out carrying the engine's crates because `[patch]` applies to
      # whatever cargo resolves there. It is a local artifact wearing
      # upstream's name.
    , lockFile
      # That lockfile's dependencies, vendored. Both move together, and with
      # the app's `bun.lock`, because that decides which generator is in
      # `node_modules`; nix prints the right hash when it changes.
    , depsHash
    }:
    let
      ubrnSrc = "${nodeModules}/uniffi-bindgen-react-native";
      vendor = pkgs.stdenv.mkDerivation {
        name = "ubrn-cargo-vendor";
        src = ubrnSrc;
        nativeBuildInputs = [ toolchain pkgs.cacert pkgs.git ];
        buildPhase = ''
          export CARGO_HOME=$PWD/.cargo-home
          cp ${lockFile} Cargo.lock
          mkdir -p $out
          cargo vendor --locked --versioned-dirs $out > $out/config.toml
        '';
        dontInstall = true;
        dontFixup = true;
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = depsHash;
      };
    in
    pkgs.stdenv.mkDerivation {
      name = "ubrn";
      src = ubrnSrc;
      nativeBuildInputs = [ toolchain pkgs.pkg-config ];
      buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR
        export CARGO_HOME=$TMPDIR/cargo
        cp ${lockFile} Cargo.lock
        chmod u+w Cargo.lock
        mkdir -p .cargo
        cat > .cargo/config.toml <<'VENDOR'
        [source.crates-io]
        replace-with = "vendored-sources"

        [source.vendored-sources]
        directory = "${vendor}"
        VENDOR
        cargo build --release --offline \
          --manifest-path crates/ubrn_cli/Cargo.toml
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        install -Dm755 target/release/uniffi-bindgen-react-native $out/bin/ubrn
        runHook postInstall
      '';
    };

  # A source tree with every Rust file emptied.
  #
  # Manifests, lockfiles and build scripts survive; `lib.rs` becomes nothing.
  # Cargo then resolves the same dependency graph, compiles all of it, and
  # compiles none of the code that changes — which is the whole trick behind
  # `mkEngine`'s first layer.
  stubSources =
    { name
    , src
      # Directories, relative to `src`, whose crates are to be emptied.
    , dirs
    }:
    pkgs.runCommand name { } ''
      cp -r ${src} $out
      chmod -R u+w $out
      for d in ${lib.escapeShellArgs dirs}; do
        [ -d "$out/$d" ] || continue
        # `build.rs` decides what a dependency compiles into, so it stays.
        find "$out/$d" -name '*.rs' -not -name 'build.rs' -print0 \
          | xargs -0 -r -I{} sh -c ': > "{}"'
      done
    '';

  # The engine cross-compiled for Android, in two layers.
  #
  # nix caches a derivation's output whole and cargo starts every derivation
  # with an empty `target/`, so one derivation means every build compiles
  # `ciborium`, `libm`, `uuid`, `libsqlite3-sys` and a hundred others again —
  # crates whose versions are fixed in a lockfile that did not change.
  #
  # So: `thirdParty` compiles the dependency graph from a tree where both the
  # app's crates *and the engine's* are stubs, and `engine` starts from that
  # `target/` with the real sources restored. Changing a mutation recompiles
  # the app's crates; bumping the engine recompiles the engine's; neither
  # touches the hundred.
  #
  # Two things make the reuse actually happen, and both are easy to get wrong:
  #
  #   - the dependencies must live at a path that is identical in both builds,
  #     so `vendor` is required rather than letting cargo fetch into a
  #     per-build `CARGO_HOME`. Measured: without it, six of twelve crates
  #     recompiled anyway.
  #   - the `target/` must be carried with `cp -a`. `cp -r` stamps every file
  #     with the current time and destroys the ordering cargo's fingerprints
  #     are built on. Measured: with `cp -a`, a warm build compiles nothing and
  #     finishes in 0.01s; with `cp -r`, it recompiles the proc-macro chain.
  mkEngine =
    { name
      # The app's tree, narrowed to what a cross-compile reads: the Rust and
      # the module's config, and not a screen or an asset. Editing a `.tsx`
      # must not be an input to this. Measured on one app: the engine half was
      # 529s of every APK build and was being paid again for a changed `.tsx`,
      # because the derivation's source was the whole repository.
    , src
    , toolchain
    , sdk
    , ubrn
      # The Expo project's dependencies: the generator resolves react-native's
      # headers through them.
    , nodeModules
      # The Expo project inside `src`, where `node_modules` goes.
    , appDir
    , petrosSrc
      # A vendored crate directory, as `cargo vendor` writes it, with the
      # `config.toml` it prints beside it.
    , vendor
      # Where the turbo module lives, relative to the source root.
    , moduleDir
      # The app's own crates, to stub for the first layer.
    , appCrates
    , ndkVersion ? android.defaultNdk
      # Run before the engine build, in the source root — an app's module is
      # generated from its own domain and may need building first.
    , preEngine ? ""
      # Run at the end of the engine's install, in the source root, for
      # whatever else an app generated on the way.
    , extraInstall ? ""
    }:
    let
      stubbedPetros = stubSources {
        name = "petros-stubbed";
        src = petrosSrc;
        dirs = [ "crates" ];
      };

      common = {
        nativeBuildInputs = [
          toolchain
          sdk
          pkgs.cargo-ndk
          pkgs.git
          pkgs.nodejs
          pkgs.python3
          pkgs.which
        ];

        ANDROID_HOME = "${sdk}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "${sdk}/libexec/android-sdk";
        ANDROID_NDK_HOME = "${sdk}/libexec/android-sdk/ndk/${ndkVersion}";

        # `cargo-ndk` sets `CC` for its child, and cc-rs consults it for *host*
        # artifacts too — and `petros-sql` is a proc macro that links SQLite,
        # so an Android build compiles libsqlite3-sys for the host as well.
        # Without this it does so with the NDK's clang, which has no glibc
        # sysroot, and fails on a missing `stdio.h`. A target-qualified
        # variable wins over the bare one.
        #
        # The triple is the *build* machine's. It read `aarch64` here once,
        # which is one development box, and set nothing at all on an x86_64
        # runner — where the only reason it built is that `__noChroot` let the
        # NDK's clang reach the host's `/usr/include`. Under a real sandbox
        # that fails on `stdio.h`, which is how this was found.
        "CC_${android.hostTriple}" = "gcc";
        "AR_${android.hostTriple}" = "ar";

        # Only where the toolchain is emulated; on x86_64 it simply runs and
        # the page size is nobody's business.
        preBuild = lib.optionalString android.needsEmulation android.emulationGuard;
      };

      # The cargo configuration both layers share: the vendored dependencies,
      # at one path, plus the patch that makes the lockfile resolvable.
      #
      # Written here rather than taken from the vendor directory. `cargo vendor`
      # prints this to stdout and cleans its output directory as it goes, so a
      # `cargo vendor $out > $out/config.toml` leaves nothing behind — the file
      # is unlinked while the redirect still holds it open. Depending on a
      # layout that a tool actively tidies is not worth the two lines saved.
      cargoConfig = engineSrc: ''
        mkdir -p .cargo
        cat > .cargo/config.toml <<'VENDOR'
        [source.crates-io]
        replace-with = "vendored-sources"

        [source.vendored-sources]
        directory = "${vendor}"
        VENDOR
        cat ${petros.mkCargoPatch engineSrc} >> .cargo/config.toml
      '';

      build = ''
        cd ${moduleDir}
        ${ubrn}/bin/ubrn build android --config ubrn.config.yaml --release
        cd -
      '';

      thirdParty = pkgs.stdenv.mkDerivation (common // {
        name = "${name}-android-deps";
        src = stubSources {
          name = "${name}-stubbed";
          inherit src;
          dirs = appCrates;
        };
        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          export CARGO_HOME=$TMPDIR/cargo
          ${cargoConfig stubbedPetros}
          ${build}
          runHook postBuild
        '';
        # Only the compiled dependencies are wanted. What the stubs produced is
        # thrown away with the rest of the build directory.
        installPhase = ''
          runHook preInstall
          cp -a target $out
          runHook postInstall
        '';
      });

      engine = pkgs.stdenv.mkDerivation (common // {
        name = "${name}-android-engine";
        inherit src;
        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          export CARGO_HOME=$TMPDIR/cargo
          ${cargoConfig petrosSrc}

          # `cp -a`, not `cp -r`. See the note above: the mtimes are the
          # fingerprints.
          echo "--- the dependency graph, already compiled"
          cp -a ${thirdParty} target
          chmod -R u+w target

          ${preEngine}

          # The generator resolves react-native's headers through this.
          echo "--- node_modules"
          cp -a ${nodeModules} ${appDir}/node_modules
          chmod -R u+w ${appDir}/node_modules

          # `#!/usr/bin/env node` is not a thing inside a sandbox. npm's shims
          # all start that way, and an unsandboxed build was quietly handing
          # them the machine's `/usr/bin/env`:
          #
          #   ./node_modules/.bin/expo: /usr/bin/env: bad interpreter
          #
          # Same shape as the compiler triple — a dependency on the host
          # filesystem that only an impure build can satisfy, and that nobody
          # notices until a machine is missing it.
          patchShebangs ${appDir}/node_modules

          echo "--- the engine, cross-compiled"
          cd ${moduleDir}
          ${ubrn}/bin/ubrn build android \
            --config ubrn.config.yaml --and-generate --release
          cd -
          runHook postBuild
        '';

        # The whole module, not a selection from it. `--and-generate` writes the
        # module's `build.gradle` and `CMakeLists.txt`, its manifest, its
        # `cpp-adapter.cpp`, its `index.tsx` and its podspec as well as the
        # libraries — and a module directory missing its `build.gradle` fails
        # in Expo's autolinking, during *settings* evaluation, as nothing more
        # specific than `command 'node' finished with non-zero exit value 1`.
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r ${moduleDir} $out/module
          ${extraInstall}
          runHook postInstall
        '';
      });
    in
    # The engine, with its layers hanging off it. An app's `packages` should be
      # derivations all the way down — `nix flake check` says so — and the first
      # layer is worth naming for `nix build .#androidDeps` when you want to know
      # whether it is the dependencies or your own code that is slow.
    engine // { inherit thirdParty stubbedPetros; };
}
