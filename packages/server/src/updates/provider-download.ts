import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostCliEnv, startableCommand } from '../cli-env'

export function httpsSource(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The agent update source must be an HTTPS URL without credentials, a query, or a fragment.')
  return url.toString().replace(/\/+$/, '')
}

/** curl uses the host's proxy, NO_PROXY, and trusted CA settings on every runtime. */
export async function downloadProviderFile(url: string, destination: string, metadata = false): Promise<void> {
  const env = hostCliEnv()
  if (!env.CURL_CA_BUNDLE && env.NODE_EXTRA_CA_CERTS) env.CURL_CA_BUNDLE = env.NODE_EXTRA_CA_CERTS
  const command = startableCommand(process.platform === 'win32' ? 'curl.exe' : 'curl', env)
  await new Promise<void>((resolve, reject) => {
    execFile(command.file, [...command.args, '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '10', '--max-time', metadata ? '30' : '300', '--retry', '2', '--retry-delay', '1', '--retry-max-time', metadata ? '30' : '300',
      '--max-filesize', metadata ? '4194304' : '536870912', '--output', destination, '--url', httpsSource(url)],
    { env, timeout: metadata ? 95_000 : 905_000, maxBuffer: 64 * 1024, windowsHide: true }, (error) => {
      // Raw curl output can contain a proxy credential. Never put it in a client event.
      if (!error) return resolve()
      if (error.code === 'ENOENT') return reject(new Error('curl is required for native agent downloads. Install curl on this host.'))
      const reason = downloadFailureReason(error.code ?? undefined)
      reject(new Error(reason))
    })
  })
}

function downloadFailureReason(code: string | number | undefined): string {
  switch (code) {
    case 5: case 6: return 'The host could not resolve the update source or proxy. Check its DNS and proxy settings.'
    case 7: return 'The host could not connect to the update source. Check its network and proxy access.'
    case 22: return 'The selected update source refused the download. Check the source address and this host’s access.'
    case 28: return 'The agent download timed out after bounded retries. Check this host’s network and proxy access.'
    case 35: case 60: return 'The host could not verify the update source’s TLS connection. Check its trusted CA bundle and proxy settings.'
    case 63: return 'The agent download exceeded the permitted file size.'
    default: return 'The agent download failed. Check this host’s proxy, trusted certificates, and access to the selected update source.'
  }
}

export async function providerMetadata(url: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-agent-metadata-'))
  try {
    const path = join(directory, 'metadata')
    await downloadProviderFile(url, path, true)
    return await readFile(path, 'utf8')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
