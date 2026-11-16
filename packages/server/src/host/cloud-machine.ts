/** Cloud metadata is link-local. One answer identifies a cloud VM. */
const METADATA_URL = 'http://169.254.169.254'
const METADATA_TIMEOUT_MS = 500

let cloudMachineRead: Promise<boolean> | null = null

export function isCloudMachine(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  cloudMachineRead ??= detectCloudMachine(fetchImpl)
  return cloudMachineRead
}

export async function detectCloudMachine(fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const requests: { url: string; init: RequestInit }[] = [
      { url: `${METADATA_URL}/latest/api/token`, init: { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: controller.signal } },
      { url: `${METADATA_URL}/computeMetadata/v1/`, init: { headers: { 'Metadata-Flavor': 'Google' }, signal: controller.signal } },
      { url: `${METADATA_URL}/metadata/instance?api-version=2021-02-01`, init: { headers: { Metadata: 'true' }, signal: controller.signal } },
    ]
    const probe = Promise.any(requests.map(async ({ url, init }) => {
      // A metadata server can answer with an error. The answer still proves that it exists.
      await fetchImpl(url, init)
      return true
    })).catch(() => false)
    return await Promise.race([probe, new Promise<false>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(false) }, METADATA_TIMEOUT_MS)
    })])
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
  }
}
