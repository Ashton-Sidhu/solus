import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Builds only the native voice helper, never the Electron or web bundles.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetArch = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7) ?? process.arch
if (targetArch !== process.arch && process.platform !== 'darwin')
  throw new Error('Build the voice helper on its target architecture')
const build = resolve(root, `build/transcription/cmake-${targetArch}`)
const output = resolve(root, 'build/transcription/bin')
mkdirSync(output, { recursive: true })
const cmake = process.env.CMAKE ?? 'cmake'
function run(args: string[]): void {
  const result = spawnSync(cmake, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native transcription build failed (${result.status})`)
}
run([
  '-S', resolve(root, 'native/transcription'), '-B', build,
  '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_INSTALL_PREFIX=${output}`,
  // Metal ships with macOS. Vulkan is enabled when CI supplies its SDK;
  // CPU remains available in every build and on machines without a GPU.
  `-DTRANSCRIBE_VULKAN=${process.env.VULKAN_SDK ? 'ON' : 'OFF'}`,
  ...(process.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${targetArch}`, `-DTRANSCRIBE_METAL=${targetArch === 'arm64' ? 'ON' : 'OFF'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0'] : []),
])
run(['--build', build, '--config', 'Release', '--target', 'solus-transcription', '--parallel', '2'])
run(['--install', build, '--config', 'Release', '--component', 'solus-voice'])
