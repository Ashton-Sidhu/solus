const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

module.exports = async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch]
  if (context.electronPlatformName !== process.platform || (arch !== process.arch && process.platform !== 'darwin'))
    throw new Error(`Build the voice helper on the target platform: ${context.electronPlatformName}/${arch}`)
  const voiceBinary = process.platform === 'win32' ? 'solus-transcription.exe' : 'solus-transcription'
  const voiceDirectory = path.join(__dirname, '../build/transcription/bin')
  if (process.env.SOLUS_VOICE_CACHE_HIT === 'true' && existsSync(path.join(voiceDirectory, voiceBinary))) {
    console.log('[beforePack] Using the cached native voice helper')
  } else {
    execFileSync('bun', [path.join(__dirname, 'build-transcription.ts'), `--arch=${arch}`], { stdio: 'inherit' })
  }
  execFileSync('bun', [path.join(__dirname, 'build-resource-monitor.ts'), `--arch=${arch}`], { stdio: 'inherit' })
}
