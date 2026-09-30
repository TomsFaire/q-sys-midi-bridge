#!/usr/bin/env bash
#
# Prepare a built macOS .app for Local Network access on macOS 15+.
#
# Two things are required and neither is done by a default electron-builder
# build with signing disabled:
#
#   1. Info.plist must carry NSLocalNetworkUsageDescription. Without it macOS
#      has no string to show in the consent prompt. (NSAllowsLocalNetworking
#      is App Transport Security -- unrelated.)
#   2. The bundle must be validly signed with our own identifier. An unsigned
#      bundle has no _CodeSignature at all and reports the stock Electron
#      signing identifier, which is not a stable identity for the app.
#
# Run after packaging, before distributing. Clears Finder detritus (xattrs and
# custom-icon files) that codesign refuses, then signs inside-out (frameworks
# and helpers first, bundle last) so nested signatures stay valid.
#
# Usage:  scripts/sign-macos.sh [path/to/App.app]
#
# Set CODESIGN_IDENTITY to a Developer ID for release builds; defaults to '-'
# (ad-hoc), which is enough for Local Network on a local install.

set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" ]]; then
  APP="$(find dist -maxdepth 2 -name '*.app' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "error: no .app found; pass the path explicitly" >&2
  exit 1
fi

IDENTITY="${CODESIGN_IDENTITY:--}"
PLIST="$APP/Contents/Info.plist"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$PLIST")"
USAGE="MIDI Q-Sys Bridge connects to your Q-SYS Core over the local network."

echo "==> app:       $APP"
echo "==> bundle id: $BUNDLE_ID"
echo "==> identity:  $IDENTITY"

# 1. Info.plist -- must happen before signing, which seals the plist.
if plutil -extract NSLocalNetworkUsageDescription raw -o - "$PLIST" >/dev/null 2>&1; then
  echo "==> NSLocalNetworkUsageDescription already present"
else
  plutil -insert NSLocalNetworkUsageDescription -string "$USAGE" "$PLIST"
  echo "==> inserted NSLocalNetworkUsageDescription"
fi

# 2. Strip Finder detritus, or codesign refuses the bundle outright. An
#    electron-builder tree that has been near Finder picks up
#    com.apple.FinderInfo / com.apple.ResourceFork xattrs and custom-icon
#    files, which fail as:
#      "resource fork, Finder information, or similar detritus not allowed"
#      "unsealed contents present in the root directory of an embedded framework"
#    Both are cosmetic Finder state, never app content, so removing them is safe.
ICONS="$(find "$APP" -name 'Icon?' | wc -l | tr -d ' ')"
if [[ "$ICONS" != "0" ]]; then
  find "$APP" -name 'Icon?' -delete
  echo "==> removed $ICONS Finder custom-icon file(s)"
fi
xattr -cr "$APP"
echo "==> cleared extended attributes"

# 3. Sign inside-out.
echo "==> signing nested code"
while IFS= read -r nested; do
  codesign --force --timestamp=none --sign "$IDENTITY" "$nested"
done < <(find "$APP/Contents/Frameworks" \
           \( -name '*.app' -o -name '*.framework' -o -name '*.dylib' \) \
           -maxdepth 1 2>/dev/null | sort -r)

echo "==> signing bundle"
codesign --force --timestamp=none --sign "$IDENTITY" \
  --identifier "$BUNDLE_ID" "$APP"

# 4. Verify, and fail the build if the identity is not what we expect.
codesign --verify --deep --strict "$APP"
ACTUAL="$(codesign -d --verbose=2 "$APP" 2>&1 | sed -n 's/^Identifier=//p')"
if [[ "$ACTUAL" != "$BUNDLE_ID" ]]; then
  echo "error: signed identifier is '$ACTUAL', expected '$BUNDLE_ID'" >&2
  exit 1
fi

echo "==> ok: $ACTUAL"
