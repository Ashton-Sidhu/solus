import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * The agent's `agent-device` launcher and its per-binding config. Adapted from
 * T3 Code (MIT, pingdotgg/t3code@43bd667, apps/server/src/device/AgentDeviceShim.ts
 * and AgentDeviceTarget.ts).
 *
 * The launcher runs the pinned install with a real Node and refuses commands
 * without `--config` and `--session`, so an agent cannot reach a daemon
 * through ambient environment variables. The config names the Solus bridge
 * and a bridge token, never the daemon's own token. Files are 0600 in a 0700
 * directory and removed when the binding ends.
 */

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export async function ensureAgentDeviceShim(input: { dir: string; nodePath: string; entryPath: string }): Promise<string> {
  const binDir = join(input.dir, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const launcher = join(binDir, 'agent-device-launcher.mjs')
  await writeFile(launcher, `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const informational = args.length === 1 && ["help", "--help", "-h", "--version", "version"].includes(args[0]);
const hasValue = (flag) => { const index = args.indexOf(flag); return index >= 0 && !!args[index + 1] && !args[index + 1].startsWith("--"); };
if (!informational && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and pass its --config and --session flags on every command.");
  process.exit(1);
}
const env = { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
delete env.AGENT_DEVICE_STATE_DIR;
const child = spawn(${JSON.stringify(input.nodePath)}, [${JSON.stringify(input.entryPath)}, ...args], { stdio: "inherit", env });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
`, { mode: 0o600 })
  const shim = join(binDir, 'agent-device')
  await writeFile(shim, `#!/bin/sh\nexec ${shellQuote(input.nodePath)} ${shellQuote(launcher)} "$@"\n`, { mode: 0o700 })
  await chmod(shim, 0o700)
  return shim
}

export function agentDeviceConfigPath(dir: string, agentSession: string): string {
  return join(dir, 'bindings', `${createHash('sha256').update(agentSession).digest('hex').slice(0, 24)}.json`)
}

/** Write the CLI config for one binding atomically, readable only by the host user. */
export async function writeAgentDeviceConfig(file: string, bridgeUrl: string, token: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  const content = JSON.stringify({ daemonBaseUrl: bridgeUrl, daemonAuthToken: token, daemonTransport: 'http' })
  if ((await readFile(file, 'utf8').catch(() => '')) === content) return
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, file)
}

export async function removeAgentDeviceConfig(file: string): Promise<void> {
  await rm(file, { force: true })
}
