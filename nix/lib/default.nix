# Everything here, as one attribute set.
#
#     petrosJs = import ./nix/lib { inherit pkgs android expo petros; };
#
# `android` and `expo` are android.nix's and expo.nix's libraries over the same
# `pkgs`; `petros` is the engine's.
{ pkgs, android, expo, petros }:
let
  rust = import ./rust.nix { inherit pkgs android petros; };
  app = import ./app.nix { inherit pkgs android expo rust; };
in
rust // app
