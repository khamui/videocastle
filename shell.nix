# Development shell. Provides the two things videocastle needs on PATH:
#   - Node.js 24 (for the built-in `node:sqlite` module)
#   - ffmpeg    (the Transcoder shells out to `ffmpeg`/`ffprobe`)
#
# Usage:
#   nix-shell                      # enter the shell
#   npm install && npm run dev:server
#
# Without ffmpeg on PATH, uploads still succeed but every transcode fails
# (the worker can't spawn ffprobe), so Videos land in the Failed state.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = [
    pkgs.nodejs_24
    pkgs.ffmpeg
  ];
}
