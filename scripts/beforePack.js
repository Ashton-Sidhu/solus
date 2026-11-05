const { execFileSync } = require('node:child_process')
const path = require('node:path')
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

module.exports = async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch]
  if (context.electronPlatformName !== process.platform || (arch !== process.arch && process.platform !== 'darwin'))
    throw new Error(`Build the voice helper on the target platform: ${context.electronPlatformName}/${arch}`)
  execFileSync('bun', [path.join(__dirname, 'build-transcription.ts'), `--arch=${arch}`], { stdio: 'inherit' })
}
