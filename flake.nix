{
  description = "videocastle development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # The systems we support a dev shell on.
      forAllSystems = f:
        nixpkgs.lib.genAttrs
          [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]
          (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Node 24 (for the built-in node:sqlite module), ffmpeg (the
          # Transcoder shells out to ffmpeg/ffprobe), and process-compose to run
          # the API + SPA together with clean teardown (`process-compose up`).
          packages = [
            pkgs.nodejs_24
            pkgs.ffmpeg
            pkgs.process-compose
          ];

          # process-compose's own admin/TUI server defaults to port 8080 — the
          # same port the app's API binds — so the two collide. Move it to 8088
          # (its web UI, if you open it, is then at http://localhost:8088).
          shellHook = ''
            export PC_PORT_NUM=8088
          '';
        };
      });
    };
}
