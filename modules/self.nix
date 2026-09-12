# This flake uses its own module, the way an app would.
{ inputs, ... }: {
  imports = [
    (import ./_petros-js.nix {
      expoModule = inputs.expo.flakeModules.default;
      petrosModule = inputs.petros.flakeModules.default;
    })
  ];
}
