# What can be checked without an app: that everything evaluates, and the
# SDK an app would get.
{
  perSystem = { pkgs, petrosJs, android, ... }: {
    packages = {
      android-sdk = android.mkSdk { };
      ndk-check = android.ndkCheck { sdk = android.mkSdk { }; };
    };
    checks.lib-evaluates = pkgs.runCommand "petros-js-lib-evaluates"
      {
        names = builtins.concatStringsSep " " (builtins.attrNames petrosJs);
      } ''
      echo "$names" > $out
    '';
  };
}
