# The library, for a consumer that is not flake-parts:
#
#     petrosJs = inputs.petros-js.lib.mkPetrosJs pkgs { };
#
# which brings `android`, `expo` and `petros` over the same `pkgs`; pass any
# of them to share one you already have.
{ inputs, ... }: {
  flake.lib.mkPetrosJs = pkgs:
    { android ? inputs.android.lib.mkAndroid pkgs
    , expo ? inputs.expo.lib.mkExpo pkgs { inherit android; }
    , petros ? inputs.petros.lib.mkPetros pkgs
    }:
    import ../nix/lib { inherit pkgs android expo petros; };
}
