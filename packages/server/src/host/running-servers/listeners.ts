import { readdir, readFile, readlink } from 'node:fs/promises'
import { runAsync } from '../../git/exec'

export interface Listener { pid: number; port: number; command: string; address?: string; processIdentity?: string }
const LOCAL = new Set(['*', '0.0.0.0', '127.0.0.1', 'localhost', '::', '::1'])

export function localListenerAddress(raw: string): string | null {
  const host = raw.replace(/^\[|\]$/g, '')
  if (!LOCAL.has(host)) return null
  return host === '::' ? '::1' : ['*', '0.0.0.0', 'localhost'].includes(host) ? '127.0.0.1' : host
}
export function parseLsofListeners(output: string): Listener[] {
  const listeners: Listener[] = []
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); command = '' }
    if (line[0] === 'c') command = line.slice(1)
    if (line[0] !== 'n' || !pid) continue
    const socket = line.slice(1)
    const colon = socket.lastIndexOf(':')
    const address = localListenerAddress(socket.slice(0, colon))
    const port = Number(socket.slice(colon + 1))
    if (address && Number.isInteger(port) && port > 0 && port < 65536) listeners.push({ pid, command, port, address })
  }
  return listeners
}
export function windowsListeners(output: string): Listener[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== 'TCP' || !['0.0.0.0:0', '[::]:0'].includes(fields[2])) return []
    const colon = fields[1].lastIndexOf(':')
    const address = localListenerAddress(fields[1].slice(0, colon))
    const port = Number(fields[1].slice(colon + 1))
    const pid = Number(fields.at(-1))
    return address && Number.isInteger(port) && port > 0 && port < 65536 && pid > 0 ? [{ pid, port, command: '', address }] : []
  })
}
export function procSocketListeners(output: string): { inode: string; port: number; address: string }[] {
  return output.split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A') return []
    const [hex, portHex] = fields[1]?.split(':') ?? []
    const address = hex === '00000000' || hex === '0100007F' ? '127.0.0.1'
      : hex === '0'.repeat(32) || hex === `${'0'.repeat(24)}01000000` ? '::1' : null
    const port = Number.parseInt(portHex, 16)
    return address && port > 0 && fields[9] ? [{ inode: fields[9], port, address }] : []
  })
}
async function linuxListeners(): Promise<Listener[]> {
  const [tcp, tcp6, entries] = await Promise.all([
    readFile('/proc/net/tcp', 'utf8'), readFile('/proc/net/tcp6', 'utf8').catch(() => ''), readdir('/proc'),
  ])
  const sockets = [...procSocketListeners(tcp), ...procSocketListeners(tcp6)]
  const wanted = new Set(sockets.map((socket) => socket.inode))
  const owners = new Map<string, { pid: number; command: string }[]>()
  let budget = 50_000
  // Bound fd traversal. If the snapshot cannot be completed, use lsof instead.
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => [])
    if (fds.length > budget) throw new Error('Process fd budget exceeded')
    budget -= fds.length
    const links = await Promise.all(fds.map((fd) => readlink(`/proc/${entry}/fd/${fd}`).catch(() => '')))
    const matched = new Set(links.flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? []).filter((inode) => wanted.has(inode)))
    if (!matched.size) continue
    const command = (await readFile(`/proc/${entry}/comm`, 'utf8').catch(() => '')).trim()
    for (const inode of matched) {
      const held = owners.get(inode) ?? []
      held.push({ pid: Number(entry), command })
      owners.set(inode, held)
    }
  }
  return sockets.flatMap((socket) => (owners.get(socket.inode) ?? []).map((owner) => ({ ...owner, port: socket.port, address: socket.address })))
}
export async function listListeningSockets(): Promise<Listener[]> {
  if (process.platform === 'linux') {
    try { return await linuxListeners() } catch { /* A restricted /proc uses lsof. */ }
  }
  if (process.platform === 'win32') {
    const tables = await Promise.all(['tcp', 'tcpv6'].map((protocol) => runAsync('netstat.exe', ['-ano', '-p', protocol], process.cwd(), { timeout: 5000 })))
    return tables.flatMap(windowsListeners)
  }
  try { return parseLsofListeners(await runAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], process.cwd(), { timeout: 5000 })) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return []
    throw new Error('Cannot read listening processes. Check process permissions and install lsof if /proc is unavailable.')
  }
}
