/**
 * The scheduled check of the Solus catalog (docs/plans/mcp-integrations.md
 * §13.5). For every entry it probes the server, as a host does when a person
 * adds it, and asks whether the integrations.sh feed now lists the same URL,
 * so the copy can be deleted. It prints one line per entry and exits non-zero
 * when an entry stopped answering. Run: `bun scripts/check-integration-catalog.ts`.
 */
import { z } from 'zod'
import { BUNDLED_SOLUS_CATALOG } from '@solus/contracts/integration-catalog'
import { probeMcpServer } from '@solus/server/integrations/probe'

const FEED_URL = 'https://integrations.sh/api.json'
const feedSchema = z.object({ data: z.array(z.object({ connectUrl: z.string().nullish() }).loose()) }).loose()

async function feedUrls(): Promise<Set<string>> {
  try {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(30_000) })
    const feed = feedSchema.parse(await response.json())
    return new Set(feed.data.flatMap((item) => (item.connectUrl ? [item.connectUrl] : [])))
  } catch {
    console.warn('The integrations.sh feed could not be read; the upstream check is skipped.')
    return new Set()
  }
}

const listedUpstream = await feedUrls()
let failures = 0
for (const entry of BUNDLED_SOLUS_CATALOG.entries) {
  const probe = await probeMcpServer(entry.url)
  const answered = probe.outcome !== 'undetermined'
  if (!answered) failures++
  const upstream = listedUpstream.has(entry.url) ? ' — integrations.sh now lists it; delete this entry' : ''
  console.log(`${answered ? 'ok  ' : 'FAIL'} ${entry.id}: ${probe.outcome}${probe.outcome === 'undetermined' ? ` (${probe.reason})` : ''}${upstream}`)
}
process.exit(failures ? 1 : 0)
