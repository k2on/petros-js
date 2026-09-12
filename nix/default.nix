# The non-flake entry point.
#
#     petrosJs = import ./nix { inherit pkgs petros; };
#
# `petros` is the engine's library, `import "${petrosSrc}/nix" { inherit pkgs; }`
# over the engine the app pins. With no `android` or `expo` given, both are
# fetched at the revisions this repository's `flake.lock` pins.
{ pkgs ? import <nixpkgs> { }
, petros
, android ? import (fetchLocked "android") { inherit pkgs; }
, expo ? import (fetchLocked "expo") { inherit pkgs android; }
}:
let
  fetchLocked = name:
    let locked = (builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.${name}.locked;
    in builtins.fetchGit {
      url = "https://github.com/${locked.owner}/${locked.repo}";
      inherit (locked) rev;
      allRefs = true;
    };
in
import ./lib { inherit pkgs android expo petros; }
