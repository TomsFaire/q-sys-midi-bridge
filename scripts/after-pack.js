/**
 * electron-builder afterPack hook.
 *
 * Runs scripts/sign-macos.sh on the packed .app so that macOS grants the app
 * Local Network access (see docs/macos-local-network.md). This has to happen in
 * afterPack rather than after `electron-builder` returns: the DMG is assembled
 * from the packed .app, so signing afterwards would leave the distributed DMG
 * carrying an unsigned bundle.
 *
 * `mac.identity` is null, so electron-builder skips signing entirely and its
 * afterSign hook never fires — afterPack is the only reliable place.
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  execFileSync(path.join(__dirname, 'sign-macos.sh'), [appPath], {
    stdio: 'inherit',
  })
}
