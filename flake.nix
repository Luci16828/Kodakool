{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [
          (final: prev: {
            nodejs = prev.nodejs_22;
            corepack = prev.corepack_22;
          })
        ];
        pkgs = import nixpkgs { inherit system overlays; };
        packages = (
          with pkgs;
          [
            nodejs
            pnpm
          ]
        );
      in
      {
        devShell = pkgs.mkShell {
          buildInputs = packages;
          nativeBuildInputs = [pkgs.playwright-driver.browsers];
          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '';
        };
      }
    );
}
