import { spawn } from 'child_process'
import { findOnPath, getCliEnv, getCliPath } from '../cli-env'
import { resolveToolBinary, type CodeIntelAdapter } from './adapters'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL_BYTES = 4_000

export interface CodeIntelToolInstallDeps {
  resolveBinary?(name: string): string | null
  resolveTool?(adapter: CodeIntelAdapter): string | null
  run?(binary: string, args: string[]): Promise<void>
}

/**
 * Install a known adapter without ever accepting a command or argument from
 * the client. The adapter table is the installation allowlist.
 */
export async function installCodeIntelTool(
  adapter: CodeIntelAdapter,
  deps: CodeIntelToolInstallDeps = {},
): Promise<void> {
  const resolveBinary = deps.resolveBinary ?? ((name) => findOnPath(name, getCliPath()))
  const resolveTool = deps.resolveTool ?? ((candidate) => resolveToolBinary(candidate, null))
  if (resolveTool(adapter)) return
  const installer = resolveBinary(adapter.installerName)
  if (!installer) {
    throw new Error(`${adapter.installerName} is required to install ${adapter.toolName}.`)
  }

  await (deps.run ?? runInstaller)(installer, adapter.installerArgs)

  if (!resolveTool(adapter)) {
    throw new Error(
      `${adapter.toolName} was installed, but Solus cannot find it on the host PATH. Restart the host or add the tool to PATH.`,
    )
  }
}

function runInstaller(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: getCliEnv({ FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let outputTail = ''
    const remember = (chunk: Buffer | string) => {
      outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout.on('data', remember)
    child.stderr.on('data', remember)

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`installation timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes`))
    }, INSTALL_TIMEOUT_MS)
    timeout.unref()

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(outputTail.trim() || `installer exited with code ${code}`))
    })
  })
}
