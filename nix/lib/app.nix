# A Petros app on a phone, from one set of parameters.
{ pkgs, android, expo, rust }:
let
  inherit (pkgs) lib;
in
{
  # Everything Android about a Petros app.
  #
  # The Rust half — `ubrn`, the engine in two layers — and the Expo half — the
  # gradle state layer and the APK in both build types — composed so that the
  # app names its files and its hashes and nothing else. What comes back is
  # every derivation on the way, because each is worth building alone when
  # something is slow or broken: `nix build .#androidDeps` answers whether it
  # is the dependencies or the app.
  mkApp =
    { name
      # The tree the APK is built from: the whole app, cleaned, with the
      # engine patch installed.
    , src
      # The tree the engine is cross-compiled from: the Rust and the module's
      # config, and nothing that is not an input to a cross-compile.
    , engineSrc
      # The Expo project inside both trees, and the same directory as a path.
    , appDir ? "."
    , appSrc
      # Where `ubrn` writes the turbo module, relative to the source root.
    , moduleDir ? "${appDir}/modules/${name}-native"
      # Where the generated TypeScript goes, relative to the Expo project.
    , mutatorsTs ? "src/mutators.gen.ts"
    , toolchain
    , petrosSrc
      # The app's dependencies, vendored: `cargo vendor` output with its
      # `config.toml` beside it.
    , vendor
      # The domain's wasm module and its TypeScript, as `petros.mkMutators`
      # builds them. `foreign_peer!` does `include_bytes!` of the module, so
      # the crate does not compile until it exists.
    , mutators
      # The crate that is the domain, and the profile its module is built
      # under; where `include_bytes!` looks.
    , crate ? name
    , wasmProfile ? "mutators"
      # The app's own crates, stubbed for the engine's first layer.
    , appCrates
      # `bun install`'s result, per system; see `expo.mkNodeModules`.
    , nodeModulesHash
      # The generator's lockfile and vendored hash; see `mkUbrn`.
    , ubrnLock
    , ubrnHash
      # Gradle's Maven graph, recorded; see `android.mkGradleBuild`.
    , gradleDeps
      # Gradle itself: a derivation, or `{ version, hash }` for `mkGradle`.
    , gradle
    , jdk ? pkgs.jdk17
    , sdk ? android.mkSdk { }
    , ndkVersion ? android.defaultNdk
      # The rest is the Expo app's; see `expo.mkExpoApp`.
    , stateSrcExclude ? [ ]
    , stateSrcFiles ? { }
    , variants ? { debug = "development"; release = "production"; }
    , archs ? [ "arm64-v8a" "x86_64" ]
    , gradleProperties ? null
    }:
    let
      gradle' = if lib.isDerivation gradle then gradle else android.mkGradle (gradle // { inherit jdk; });

      nodeModules = expo.mkNodeModules {
        name = "${name}-expo-node-modules";
        src = expo.cleanExpoSource appSrc;
        hash = nodeModulesHash;
      };

      ubrn = rust.mkUbrn {
        inherit toolchain nodeModules;
        lockFile = ubrnLock;
        depsHash = ubrnHash;
      };

      wasm = "target/wasm32-unknown-unknown/${wasmProfile}/${crate}.wasm";
      ts = "${appDir}/${mutatorsTs}";

      engine = rust.mkEngine {
        inherit name toolchain sdk ubrn nodeModules appDir petrosSrc vendor
          moduleDir appCrates ndkVersion;
        src = engineSrc;
        preEngine = ''
          # The module, already built. The wasm goes back where
          # `include_bytes!` expects it, because compiling the crate with its
          # foreign feature reads it — that is what makes this a build input
          # and not a test fixture.
          echo "--- the mutator module, prebuilt"
          mkdir -p "$(dirname ${ts})" "$(dirname ${wasm})"
          cp ${mutators}/mutators.gen.ts ${ts}
          cp ${mutators}/${crate}.wasm ${wasm}
          chmod -R u+w "$(dirname ${ts})" target/wasm32-unknown-unknown
        '';
        extraInstall = ''
          install -Dm444 ${ts} $out/mutators.gen.ts
        '';
      };

      app = expo.mkExpoApp {
        inherit name src appDir appSrc nodeModules gradleDeps sdk jdk ndkVersion
          variants archs gradleProperties stateSrcFiles;
        gradle = gradle';
        # The Rust toolchain and `cargo-ndk`, ahead of everything else: the
        # module's `build.gradle` may reach for them.
        nativeBuildInputs = [ toolchain pkgs.cargo-ndk ];
        extraAttrs = {
          # As in `mkEngine`, and for the same reason: cc-rs reads `CC` for
          # host artifacts and `cargo-ndk` sets it to the NDK's clang.
          "CC_${android.hostTriple}" = "gcc";
          "AR_${android.hostTriple}" = "ar";
        };
        # The engine and its bindings, already built, in the APK builds only:
        # the state layer must not see the module, so that a changed mutation
        # cannot invalidate a gradle build that never saw one.
        buildPrepare = ''
          export CARGO_HOME=$TMPDIR/cargo

          echo "--- the engine, prebuilt"
          rm -rf ${moduleDir}
          cp -r ${engine}/module ${moduleDir}
          cp ${engine}/mutators.gen.ts ${ts}
          chmod -R u+w ${moduleDir} "$(dirname ${ts})"
        '';
        # The module is the engine's, and the generator's lockfile is the
        # generator's own build: neither is an input to the gradle layer.
        stateSrcExclude = [ "modules" "ubrn-Cargo.lock" ] ++ stateSrcExclude;
      };
    in
    {
      inherit sdk nodeModules ubrn engine;
      gradle = gradle';
      # The first layer on its own, for when the question is whether it is
      # the dependencies or the app that is slow.
      deps = engine.thirdParty;
      # …and the same layer with the guest's loader narrating.
      #
      # This is the layer that fails under emulation, and it fails in a way
      # `ndk-check` cannot reproduce: that check drives the same clang through
      # the same wrapper and passes, so the binary is fine and the *context*
      # is not. cargo sets `LD_LIBRARY_PATH` when it runs a build script — the
      # target's `deps` and the rust toolchain's own `lib` — and
      # `libsqlite3-sys` hands that environment to clang. Which is why running
      # the failing command by hand afterwards proves nothing: by hand is the
      # case that works. So ask from inside.
      deps-debug = engine.thirdParty.overrideAttrs (_: {
        name = "${name}-android-deps-debug";
        NDK_EMULATION_DEBUG = "1";
      });
      ndk-check = android.ndkCheck { inherit sdk ndkVersion; };
      inherit (app) stateSrc gradleState apk-debug apk-release apk;
    };
}
