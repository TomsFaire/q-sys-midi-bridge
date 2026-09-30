# macOS Local Network access

On macOS 15 and later, reaching a host on the LAN — including the Q-SYS Core's
QRC port (1710) — requires the user to grant Local Network access to the app.
The control is in **System Settings → Privacy & Security → Local Network**. It
is *not* in System Settings → Network, which is a common place to go looking.

A default `electron-builder` build with signing disabled does not satisfy the
requirements, and the failure is silent: `connect()` never reaches the wire, so
the bridge reports a bare "Disconnected" while the Core is perfectly reachable
from the same machine with `nc -z <core> 1710`.

Two things are needed:

1. **`NSLocalNetworkUsageDescription` in `Info.plist`** — the string macOS shows
   in the consent prompt. Note that `NSAllowsLocalNetworking` is an App
   Transport Security key and does *not* cover this.
2. **A validly signed bundle carrying our own identifier.** An unsigned bundle
   has no `Contents/_CodeSignature` at all and reports the stock `Electron`
   signing identifier rather than `com.tomsfaire.midi-qsys-bridge`.

`scripts/sign-macos.sh` does both. Run it after packaging:

```sh
scripts/sign-macos.sh "dist/mac-arm64/MIDI Q-Sys Bridge.app"
```

Set `CODESIGN_IDENTITY` to a Developer ID for release builds; it defaults to
ad-hoc (`-`), which is sufficient for Local Network on a local install.

## Finder detritus blocks signing

A build tree that has been near Finder picks up `com.apple.FinderInfo` and
`com.apple.ResourceFork` extended attributes, plus `Icon\r` custom-icon files —
the 0.2.5 build in `release/` carries 300 xattrs and 145 icon files. `codesign`
refuses both, and the two errors look unrelated to each other:

```
Squirrel.framework: resource fork, Finder information, or similar detritus not allowed
Squirrel.framework: unsealed contents present in the root directory of an embedded framework
```

The first is the xattrs, the second is the icon file sitting in the framework
root. `scripts/sign-macos.sh` clears both before signing — they are cosmetic
Finder state, never app content. If you sign by hand, do the same first:

```sh
find "$APP" -name 'Icon?' -delete
xattr -cr "$APP"
```

## Diagnosing

```sh
# Is the Core reachable at all, independent of the app?
nc -z -v -w 3 <core-ip> 1710

# Does the app process actually hold a socket to it?
lsof -nP -p "$(pgrep -f 'MIDI Q-Sys Bridge' | head -1)" -a -i
```

If the Core answers but the app shows only its own UCI listener on `:3001` with
no `->` entry to port 1710, the connection is being refused locally and this is
the cause. Check the signature with:

```sh
codesign -dv --verbose=2 "/Applications/MIDI Q-Sys Bridge.app"
```

`Identifier=Electron` or a missing `_CodeSignature` means the bundle needs
`scripts/sign-macos.sh`.

## Repairing an already-installed copy

Re-signing in place fixes it without a rebuild; the app reconnects on next
launch and the grant persists across restarts.

```sh
osascript -e 'quit app "MIDI Q-Sys Bridge"'
scripts/sign-macos.sh "/Applications/MIDI Q-Sys Bridge.app"
open -a "MIDI Q-Sys Bridge"
```
