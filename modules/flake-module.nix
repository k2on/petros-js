# The flake-parts module an app imports.
#
#     imports = [ inputs.petros-js.flakeModules.default ];
#     perSystem = { petrosJs, petros, ... }: {
#       packages = petrosJs.mkApp { … };
#     };
{ inputs, ... }: {
  flake.flakeModules.default = import ./_petros-js.nix {
    expoModule = inputs.expo.flakeModules.default;
    petrosModule = inputs.petros.flakeModules.default;
  };
}
