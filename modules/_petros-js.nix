# The module itself, as a function of the modules it builds on — so the
# flake that exports it can close it over its own inputs, and an app needs
# none of them: `petros-js` is the one input, and `android`, `expo` and
# `petros` arrive through it. In a file import-tree does not load on its own.
{ expoModule, petrosModule }: {
  # Keyed, so that an app which also imports this some other way gets one
  # copy rather than two definitions of `_module.args.petrosJs`.
  key = "petros-js";
  _file = toString ./_petros-js.nix;
  imports = [ expoModule petrosModule ];
  perSystem = { pkgs, android, expo, petros, ... }: {
    _module.args.petrosJs = import ../nix/lib { inherit pkgs android expo petros; };
  };
}
