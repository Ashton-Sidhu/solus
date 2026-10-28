const path = require('node:path')

/** electron-builder supplies different bundle roots on macOS, Linux, and Windows. */
function packageLayout(context) {
  const name = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(context.appOutDir, `${name}.app`)
    return {
      appPath,
      resourcesDir: path.join(appPath, 'Contents', 'Resources'),
      executable: path.join(appPath, 'Contents', 'MacOS', name),
      fusePath: appPath,
    }
  }
  if (context.electronPlatformName === 'linux') {
    const executable = path.join(context.appOutDir, context.packager.executableName)
    return {
      appPath: context.appOutDir,
      resourcesDir: path.join(context.appOutDir, 'resources'),
      executable,
      fusePath: executable,
    }
  }
  if (context.electronPlatformName === 'win32') {
    const executable = path.join(context.appOutDir, `${name}.exe`)
    return {
      appPath: context.appOutDir,
      resourcesDir: path.join(context.appOutDir, 'resources'),
      executable,
      fusePath: executable,
    }
  }
  throw new Error(`Unsupported desktop package platform: ${context.electronPlatformName}`)
}

module.exports = { packageLayout }
