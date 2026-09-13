# A Petros app's phone, as a flake-parts module.
#
# An app imports this from the `@petros/client` revision its `package.json`
# pins — the same repository, so the client a screen calls and the build that
# puts the engine under it cannot drift — and says what only it knows:
#
#     mobile = {
#       name = "harken";
#       nodeModulesHash = { x86_64-linux = "sha256-…"; };
#       ubrnHash = "sha256-…";
#       gradle = { version = "9.3.1"; hash = "sha256-…"; };
#       eas.profiles = { … };
#     };
#
# Everything else follows: `bun install` as a fixed-output derivation, `ubrn`
# from a committed lockfile, the engine cross-compiled in two layers, the
# Expo project's gradle state carried between builds, the APK in both build
# types — and the files the directory would otherwise repeat nix's facts in,
# generated: `eas.json`, the turbo module's `ubrn.config.yaml`, and the EAS
# hook that builds the Rust in a container with no nix.
#
# It builds on `petros`'s app modules: `toolchain`, `sources`, `petros`,
# `petrosSrc` and `script` are theirs.
{ lib, flake-parts-lib, ... }: {
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.mobile = {
      name = lib.mkOption { type = lib.types.str; description = "The app; the turbo module is `<name>-native`."; };
      dir = lib.mkOption { type = lib.types.str; default = "mobile"; description = "The Expo project, relative to the root."; };
      crate = lib.mkOption { type = lib.types.str; description = "The domain crate `ubrn` builds. Defaults to the name."; };
      abis = lib.mkOption {
        type = lib.types.listOf (lib.types.enum [ "arm64-v8a" "x86_64" "armeabi-v7a" "x86" ]);
        default = [ "arm64-v8a" "x86_64" ];
        description = "arm64 covers every device made this decade; x86_64 is an emulator on a laptop.";
      };
      nodeModulesHash = lib.mkOption { type = lib.types.attrsOf lib.types.str; description = "`bun install`'s result, per system; nix prints the right one."; };
      ubrnHash = lib.mkOption { type = lib.types.str; description = "The generator's vendored dependencies, from `ubrn-Cargo.lock`."; };
      gradle = lib.mkOption { type = lib.types.attrsOf lib.types.str; description = "`{ version, hash }` of the gradle the project's template pins."; };
      stateSrcExclude = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; description = "What in the project the gradle layer must not see, beyond the defaults."; };
      stateSrcFiles = lib.mkOption { type = lib.types.attrsOf lib.types.str; default = { }; description = "Files the gradle layer's source needs to exist, such as a stub route."; };
      eas.profiles = lib.mkOption { type = lib.types.attrs; default = { }; description = "`eas.json`'s build profiles; `base` gets the Rust environment."; };
    };
  };

  config.perSystem = { config, pkgs, lib, toolchain, rustVersion, petros, petrosSrc, sources, script, appRoot, self', ... }:
    let
      cfg = config.mobile;
      petrosJs = import ../default.nix { inherit pkgs petros; };
      moduleDir = "${cfg.dir}/modules/${cfg.name}-native";
      rustTarget = { arm64-v8a = "aarch64-linux-android"; x86_64 = "x86_64-linux-android"; armeabi-v7a = "armv7-linux-androideabi"; x86 = "i686-linux-android"; };
      targets = map (abi: rustTarget.${abi}) cfg.abis;
      manifest = builtins.fromTOML (builtins.readFile (appRoot + "/Cargo.toml"));
      engineRev = manifest.workspace.dependencies.petros.rev;
      crateName = dir: (builtins.fromTOML (builtins.readFile (appRoot + "/${dir}/Cargo.toml"))).package.name;
      crateDir = lib.findFirst (m: crateName m == cfg.crate) (throw "mobile: no workspace member is the crate `${cfg.crate}`") manifest.workspace.members;
      up = lib.concatStringsSep "/" (map (_: "..") (lib.splitString "/" moduleDir));
      ubrn = "./${cfg.dir}/node_modules/.bin/ubrn";
      install = "(cd ${cfg.dir} && bun install)";

      app = petrosJs.mkApp {
        inherit (cfg) name crate;
        inherit toolchain petrosSrc moduleDir;
        src = sources.workspace;
        engineSrc = sources.engineWorkspace;
        appDir = cfg.dir;
        appSrc = appRoot + "/${cfg.dir}";
        appCrates = manifest.workspace.members;
        vendor = sources.cargoDeps;
        mutators = self'.packages.mutators;
        mutatorsTs = lib.removePrefix "${cfg.dir}/" config.petros.mutators.ts;
        archs = cfg.abis;
        nodeModulesHash = cfg.nodeModulesHash;
        ubrnLock = appRoot + "/${cfg.dir}/ubrn-Cargo.lock";
        inherit (cfg) ubrnHash gradle stateSrcFiles;
        gradleDeps = appRoot + "/${cfg.dir}/gradle-deps.json";
        # Generated files and this module are not gradle's business.
        stateSrcExclude = [ "eas.json" "eas-rust.sh" "gradle-deps.json" "nix" ] ++ cfg.stateSrcExclude;
      };
    in
    {
      mobile.crate = lib.mkDefault cfg.name;

      # The cross-compile reads the module's config beside the crates.
      petros.engineSrc = [ moduleDir ];
      # Metro and the Expo CLI are node programs even when bun runs them.
      petros.shell.packages = [ pkgs.bun pkgs.nodejs_22 pkgs.eas-cli ];

      packages = {
        androidSdk = app.sdk;
        gradle9 = app.gradle;
        expoModules = app.nodeModules;
        inherit (app) ubrn ndk-check gradleState apk-debug apk-release apk;
        androidEngine = app.engine;
        androidDeps = app.deps;
        androidDeps-debug = app.deps-debug;
      };

      files.file = {
        "${cfg.dir}/eas.json".source = (pkgs.formats.json { }).generate "eas.json" {
          cli = { version = ">= 12.0.0"; appVersionSource = "remote"; };
          build = cfg.eas.profiles // {
            # What the EAS hook installs and builds: the toolchain nix names,
            # its targets, and the engine `Cargo.toml` pins.
            base = (cfg.eas.profiles.base or { }) // {
              env = (cfg.eas.profiles.base.env or { }) // {
                RUST_VERSION = rustVersion;
                RUST_TARGETS = lib.concatStringsSep " " targets;
                PETROS_REV = engineRev;
                CARGO_TERM_COLOR = "never";
              };
            };
          };
          submit.production = { };
        };

        # How the turbo module is wired to the Rust: the domain crate itself,
        # with its binding layer switched on. `--features foreign` is off by
        # default so the server and the desktop client do not build uniffi
        # and a wasm interpreter to reach the same `apply`.
        "${moduleDir}/ubrn.config.yaml".source = (pkgs.formats.yaml { }).generate "ubrn.config.yaml" {
          rust = { directory = up; manifestPath = "${crateDir}/Cargo.toml"; };
          bindings = { cpp = "cpp/generated"; ts = "src/generated"; };
          android = { directory = "android"; targets = cfg.abis; apiLevel = 24; cargoExtras = [ "--features" "foreign" ]; };
          ios = { directory = "ios"; targets = [ "aarch64-apple-ios" "aarch64-apple-ios-sim" ]; cargoExtras = [ "--features" "foreign" ]; };
        };

        # The Rust half of an EAS build. EAS gives two slots: `pre-install`,
        # before node_modules exist, installs the toolchain `eas.json` names;
        # `post-install`, after `expo prebuild`, builds the mutator module,
        # hands it to the bundler, and cross-compiles the engine — React
        # Native autolinks at gradle *configure* time, so a turbo module that
        # appears here is still found.
        "${cfg.dir}/eas-rust.sh".text = ''
          #!/usr/bin/env bash
          # Generated by `nix run .#write-files` from the petros-js mobile module.
          set -euo pipefail
          stage="''${1:?usage: eas-rust.sh pre|post}"
          root="$PWD"
          while [ ! -f "$root/Cargo.toml" ] && [ "$root" != "/" ]; do root="$(dirname "$root")"; done
          [ -f "$root/Cargo.toml" ] || { echo "eas-rust: no cargo workspace above $PWD" >&2; exit 1; }
          app="$PWD"

          case "$stage" in
            pre)
              if command -v cargo >/dev/null && command -v cargo-ndk >/dev/null; then
                echo "--- rust already present: $(rustc --version)"; exit 0
              fi
              echo "--- installing Rust $RUST_VERSION for $(uname -m)"
              curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
                | sh -s -- -y --default-toolchain none --profile minimal --no-modify-path
              . "$HOME/.cargo/env"
              # shellcheck disable=SC2086
              rustup toolchain install "$RUST_VERSION" --profile minimal \
                $(for t in $RUST_TARGETS; do printf ' --target %s' "$t"; done)
              rustup default "$RUST_VERSION"
              cargo install cargo-ndk --locked --version '^3'
              ;;
            post)
              . "$HOME/.cargo/env"
              if [ -z "''${ANDROID_NDK_HOME:-}" ] && [ -d "''${ANDROID_SDK_ROOT:-}/ndk" ]; then
                ANDROID_NDK_HOME="$(ls -d "$ANDROID_SDK_ROOT"/ndk/* | sort -V | tail -1)"; export ANDROID_NDK_HOME
              fi
              echo "--- ndk: ''${ANDROID_NDK_HOME:-<none>}"
              cd "$root"
              echo "--- the mutator module"
              cargo build -p ${config.petros.mutators.crate} --no-default-features \
                --target wasm32-unknown-unknown --profile ${config.petros.mutators.profile}
              # The generator at the engine's own revision, so it agrees with the
              # module about the schema section; kept in target/ for a second
              # build in the same container.
              [ -x target/codegen/bin/petros-codegen ] || cargo install --quiet \
                --git https://github.com/k2on/petros --rev "$PETROS_REV" --root target/codegen petros-codegen
              target/codegen/bin/petros-codegen \
                target/wasm32-unknown-unknown/${config.petros.mutators.profile}/${config.petros.mutators.crate}.wasm \
                ${config.petros.mutators.ts}
              echo "--- the engine, cross-compiled"
              cd "$app/modules/${cfg.name}-native"
              "$app/node_modules/.bin/ubrn" build android --config ubrn.config.yaml --and-generate --release
              ;;
            *) echo "eas-rust: unknown stage \"$stage\"" >&2; exit 1 ;;
          esac
        '';
      };

      apps = {
        # Regenerate the client's TypeScript and C++ from a host build of the
        # domain crate, then typecheck the app against it — no NDK, no Xcode.
        # ubrn writes new files and never removes old ones, so what was
        # generated before is wiped first.
        bindings.program = script "bindings" {
          runtimeInputs = [ pkgs.bun pkgs.nodejs_22 ];
          text = ''
            ${install}
            cargo build -p ${cfg.crate} --features foreign
            case "$(uname -s)" in Darwin) lib=lib${cfg.crate}.dylib ;; *) lib=lib${cfg.crate}.so ;; esac
            rm -rf ${moduleDir}/src/generated ${moduleDir}/cpp/generated ${moduleDir}/android/src/main/java
            ${ubrn} generate jsi bindings "target/debug/$lib" --library --no-format \
              --ts-dir ${moduleDir}/src/generated --cpp-dir ${moduleDir}/cpp/generated
            (cd ${moduleDir} && "$OLDPWD/${ubrn}" generate jsi turbo-module \
              --config ubrn.config.yaml --native-bindings ${cfg.crate})
            (cd ${cfg.dir} && ./node_modules/.bin/tsc --noEmit)
          '';
        };
        # Build the Rust for a phone, regenerate, and run the app. Needs the
        # SDK and the NDK: `nix develop .#android -c nix run .#expo-android`.
        expo-android.program = script "expo-android" {
          runtimeInputs = [ pkgs.bun pkgs.nodejs_22 pkgs.cargo-ndk ];
          text = ''
            ${install}
            (cd ${moduleDir} && "$OLDPWD/${ubrn}" build android --config ubrn.config.yaml --and-generate --release)
            (cd ${cfg.dir} && bunx expo prebuild --platform android --clean && bunx expo run:android)
          '';
        };
        expo-ios.program = script "expo-ios" {
          runtimeInputs = [ pkgs.bun pkgs.nodejs_22 ];
          text = ''
            ${install}
            (cd ${moduleDir} && "$OLDPWD/${ubrn}" build ios --config ubrn.config.yaml --and-generate --release)
            (cd ${cfg.dir} && bunx expo prebuild --platform ios --clean && bunx expo run:ios)
          '';
        };
        # Re-record gradle's Maven graph. Working out what a gradle build
        # fetches is a Turing-complete question, so nixpkgs runs the build
        # once behind a recording proxy and keeps what came back. Needs the
        # network and costs a full build; anything after `--` goes to
        # `nix build`.
        gradle-deps.program = pkgs.writeShellApplication {
          name = "gradle-deps";
          runtimeInputs = [ pkgs.git ];
          text = ''
            cd "$(git rev-parse --show-toplevel)"
            [ -s ${cfg.dir}/gradle-deps.json ] || echo '{}' > ${cfg.dir}/gradle-deps.json
            s=$(nix build --no-link --print-out-paths ".#apk-debug.mitmCache.updateScript" "$@")
            # Without bubblewrap: it clears the environment, which behind a
            # proxy leaves nix unable to fetch.
            USE_BWRAP=0 "$s"
            echo "wrote ${cfg.dir}/gradle-deps.json"
          '';
        };
      };

      # The default shell plus the two tools that turn Rust into an Android
      # library. The SDK and the NDK are *not* here, on purpose: the Android
      # Gradle Plugin installs missing components into the SDK directory and a
      # store path is read-only, so bring your own and export `ANDROID_HOME`.
      # `nix build .#apk` supplies its own, pinned.
      devShells.android = pkgs.mkShell {
        inputsFrom = [ self'.devShells.default ];
        packages = [ pkgs.cargo-ndk pkgs.jdk17 pkgs.jq ];
        shellHook = ''
          if [ -z "''${ANDROID_HOME:-}" ] && [ -n "''${ANDROID_SDK_ROOT:-}" ]; then
            export ANDROID_HOME="$ANDROID_SDK_ROOT"
          fi
          if [ -z "''${ANDROID_HOME:-}" ]; then
            echo "android shell: no ANDROID_HOME. Install the SDK and export it." >&2
          else
            export ANDROID_SDK_ROOT="''${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
            if [ -z "''${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
              export ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)"
            fi
            echo "android shell — nix run .#expo-android (sdk: $ANDROID_HOME, ndk: ''${ANDROID_NDK_HOME:-<none>})"
          fi
        '';
      };
    };
}
