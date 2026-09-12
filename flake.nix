{
  description = "petros-js — the TypeScript side of Petros, and how a Petros app reaches a phone";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    import-tree.url = "github:vic/import-tree";
    android = {
      url = "github:k2on/android.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
      inputs.import-tree.follows = "import-tree";
    };
    expo = {
      url = "github:k2on/expo.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
      inputs.import-tree.follows = "import-tree";
      inputs.android.follows = "android";
    };
    petros = {
      url = "github:k2on/petros";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
      inputs.import-tree.follows = "import-tree";
    };
  };

  # Dendritic: every file under `modules/` is a flake-parts module. An app
  # wants `flakeModules.default`, which puts `petrosJs`, `petros`, `expo` and
  # `android` in scope of its every `perSystem` — one import, and one nixpkgs.
  outputs = inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } (inputs.import-tree ./modules);
}
