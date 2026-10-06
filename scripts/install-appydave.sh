#!/usr/bin/env bash
# Build the `appydave` branch and install it AS /Applications/KYBER Studio.app.
#
# Why: Ian's released app in /Applications has no local-agents code, so opening
# Studio from the Dock showed the wrong agents (kybsite, Scoop missing). Both
# report the same version, so nothing told the two apart. Now the Dock icon IS
# this branch.
#
# - Packaged with no publish feed (no app-update.yml), so the updater finds
#   nothing and never offers Ian's release over this build.
# - Ad-hoc signed: macOS asks once per install for the login keychain password
#   ("kyber-studio Safe Storage"). Click "Always Allow".
# - The replaced app is moved to ~/dev/kybernesis/_backup/, never deleted.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(git branch --show-current)" = "appydave" ] || { echo "not on appydave branch" >&2; exit 1; }

source "$HOME/.nvm/nvm.sh" >/dev/null
nvm use 24.21.0 >/dev/null   # 24.13 fails the test gate (electron named-export error)

npm run fetch:speech
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 \
  -c.mac.identity=null -c.mac.notarize=false -c.publish=null \
  -c.directories.output=dist/appydave

APP="dist/appydave/mac-arm64/KYBER Studio.app"
codesign --force --deep -s - "$APP"
[ "$(grep -c -a local-agents.json "$APP/Contents/Resources/app.asar")" -gt 0 ] || { echo "built app lacks local agents" >&2; exit 1; }

osascript -e 'quit app "KYBER Studio"' || true
for _ in $(seq 1 15); do pgrep -f "KYBER Studio.app/Contents/MacOS" >/dev/null || break; sleep 1; done

BACKUP="$HOME/dev/kybernesis/_backup"; mkdir -p "$BACKUP"
if [ -d "/Applications/KYBER Studio.app" ]; then
  mv "/Applications/KYBER Studio.app" "$BACKUP/KYBER Studio ($(date +%Y%m%d-%H%M)).app"
fi
ditto "$APP" "/Applications/KYBER Studio.app"
open "/Applications/KYBER Studio.app"
echo "Installed appydave build $(git rev-parse --short HEAD) as /Applications/KYBER Studio.app"
