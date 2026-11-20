#!/bin/sh
# mods/nanj を Herdr app の mods フォルダへコピーする。
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/nanj"
mkdir -p "$dest"
rsync -a --delete "$here/mods/nanj/" "$dest/"
echo "installed: $dest"
