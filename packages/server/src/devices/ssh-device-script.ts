import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from '@solus/contracts/device-types'

/**
 * The Node program Solus runs on an SSH device host. It is sent as data on
 * the SSH session's stdin, so nothing in it is shell text, and it answers
 * with one JSON line. Adapted from T3 Code (MIT, pingdotgg/t3code@43bd667,
 * apps/server/src/device/sshDeviceScript.ts).
 *
 * Modes:
 * - `probe`: read-only. Node, npm and platform checks plus installed tool versions.
 * - `start`: install the pinned hub if missing, start it on loopback, report its port.
 * - `agent-start`: `start`, plus the pinned agent-device daemon.
 * - `stop-agent` / `stop`: stop only helpers this owner started (recorded PID and
 *   entry path on its command line). Simulators keep running.
 */

export type SshScriptMode = 'probe' | 'start' | 'agent-start' | 'stop-agent' | 'stop'

/** Resolve common non-interactive Node and SDK locations without sourcing shell profiles. */
export const REMOTE_ENVIRONMENT = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -z "$ANDROID_HOME" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -n "$ANDROID_HOME" ]; then export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; fi
`

/** The remote command: set PATH, then read the program from stdin. */
export const REMOTE_COMMAND = `sh -c '${REMOTE_ENVIRONMENT.replaceAll("'", "'\"'\"'")}exec node -'`

export function sshDeviceScript(owner: string, mode: SshScriptMode): string {
  return `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const hubVersion = ${JSON.stringify(DEVICE_HUB_VERSION)};
const agentVersion = ${JSON.stringify(AGENT_DEVICE_VERSION)};
` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.solus', 'devices');
const state = path.join(root, 'hosts', owner);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const healthy = async (port, route) => { try { return (await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const toolDir = (name, version) => path.join(root, 'tools', name, version);
const installed = (name, version, entry) => {
  const dir = toolDir(name, version);
  try { return fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version && fs.existsSync(path.join(dir, 'node_modules', name, entry)); } catch { return false; }
};
const versionsOf = (name, required, entry, running) => {
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'tools', name)); } catch {}
  const list = names.filter(v => /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(v) && installed(name, v, entry)).sort();
  return { requiredVersion: required, installedVersions: list, runningVersion: running };
};
const stopRecorded = (record) => {
  if (!record || record.owner !== owner || !record.pid) return;
  const command = run('ps', ['-p', String(record.pid), '-o', 'command=']).stdout || '';
  if (command.includes(record.entryPath)) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
};
async function install(name, version, entry) {
  const dir = toolDir(name, version);
  const file = path.join(dir, 'node_modules', name, entry);
  if (installed(name, version, entry)) return file;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = dir + '.lock';
  const deadline = Date.now() + 600000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (installed(name, version, entry)) return file;
      if (Date.now() > deadline) throw Error('Another install of ' + name + ' holds ' + lock + '.');
      await sleep(500);
    }
  }
  let staging;
  try {
    if (installed(name, version, entry)) return file;
    staging = fs.mkdtempSync(path.join(path.dirname(dir), '.staging-'));
    const result = run('npm', ['install', '--prefix', staging, '--no-fund', '--no-audit', '--no-save', name + '@' + version], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw Error('Installing ' + name + ' failed: ' + String(result.stderr || '').split('\n').find(Boolean));
    if (!fs.existsSync(path.join(staging, 'node_modules', name, entry))) throw Error('Missing installed entry for ' + name + '.');
    fs.writeFileSync(path.join(staging, '.install-complete'), version + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return file;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
(async () => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
  const npmOk = run('npm', ['--version']).status === 0;
  const xcode = process.platform === 'darwin' ? (run('xcode-select', ['-p']).stdout || '').trim() : '';
  const ios = process.platform === 'darwin' && !xcode.includes('CommandLineTools') && run('xcrun', ['simctl', 'help']).status === 0;
  const android = run('adb', ['version']).status === 0;
  const platforms = [
    { platform: 'ios', available: ios, ...(!ios ? { reason: process.platform !== 'darwin' ? 'iOS Simulators need macOS with Xcode.' : xcode.includes('CommandLineTools') ? 'Command Line Tools are selected instead of Xcode on the device host.' : 'Xcode simulator tools are not available on the device host.' } : {}) },
    { platform: 'android', available: android, ...(!android ? { reason: 'Android SDK was not found. Set ANDROID_HOME or put adb on the SSH PATH.' } : {}) },
  ];
  const hubFile = path.join(state, 'hub.json');
  const daemonFile = path.join(state, 'daemon.json');
  const hubRecord = read(hubFile);
  const tools = {
    hub: versionsOf('expo-device-hub', hubVersion, 'dist/server/cli.mjs', hubRecord && hubRecord.owner === owner ? hubVersion : null),
    agent: versionsOf('agent-device', agentVersion, 'bin/agent-device.mjs', read(daemonFile) ? agentVersion : null),
  };
  if (mode === 'probe') {
    console.log(JSON.stringify({ nodeVersion: process.versions.node, nodeOk, npmOk, platforms, tools }));
    return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const agentEntryFor = () => path.join(toolDir('agent-device', agentVersion), 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
  if (mode === 'stop' || mode === 'stop-agent') {
    if (fs.existsSync(agentEntryFor())) run(process.execPath, [agentEntryFor(), 'daemon', 'stop', '--state-dir', state]);
    if (mode === 'stop') { stopRecorded(hubRecord); fs.rmSync(hubFile, { force: true }); }
    console.log(JSON.stringify({ stopped: true }));
    return;
  }
  if (!nodeOk) throw Error('Node.js 22.12 or newer is required on the device host.');
  if (!ios && !android) throw Error(platforms.map(p => p.reason).join(' '));
  const hubEntry = await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
  let hub = hubRecord;
  if (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || !await healthy(hub.port, '/readyz')) {
    stopRecorded(hub);
    const hubPort = await freePort();
    const log = fs.openSync(path.join(state, 'hub.log'), 'a');
    const child = spawn(process.execPath, [hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'], {
      cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    fs.closeSync(log);
    child.unref();
    hub = { owner, pid: child.pid, port: hubPort, entryPath: hubEntry };
    write(hubFile, hub);
    const deadline = Date.now() + 30000;
    while (!await healthy(hub.port, '/readyz')) {
      if (child.exitCode !== null || Date.now() > deadline) { stopRecorded(hub); fs.rmSync(hubFile, { force: true }); throw Error('The device hub did not become ready on the device host.'); }
      await sleep(200);
    }
  }
  let agent = {};
  if (mode === 'agent-start') {
    const agentEntry = await install('agent-device', agentVersion, 'bin/agent-device.mjs');
    let daemon = read(daemonFile);
    if (daemon && !await healthy(daemon.httpPort, '/health')) { fs.rmSync(daemonFile, { force: true }); daemon = null; }
    if (!daemon) {
      const env = { ...process.env, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_DAEMON_SERVER_MODE: 'http', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
      delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG;
      run(process.execPath, [agentEntry, 'devices', '--json'], { env });
      daemon = read(daemonFile);
    }
    if (!daemon || !await healthy(daemon.httpPort, '/health')) throw Error('agent-device did not start on the device host.');
    agent = { daemonPort: daemon.httpPort, token: daemon.token };
  }
  const vendor = path.resolve(path.dirname(hubEntry), '../../vendor/serve-sim/dist');
  const optional = file => fs.existsSync(file) ? file : null;
  console.log(JSON.stringify({ nodeVersion: process.versions.node, nodeOk, npmOk, platforms, tools, nodePath: process.execPath, hubPort: hub.port, ...agent,
    helpers: { serveSimAxSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
})().catch(error => { console.error(String(error && error.message || error)); process.exitCode = 1; });
`
}
