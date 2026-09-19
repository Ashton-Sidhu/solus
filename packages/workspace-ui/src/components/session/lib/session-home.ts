/**
 * One row per session across its homes (docs/plans/cloud-service-model.md, R1/R8).
 *
 * A session's transcript lives on the runner that ran it; the organization's
 * workspace service keeps its record. Both list it, and the picker must not show
 * the same conversation twice. The runner is the row while it is connected — it
 * can open the transcript. When it is not, the record stands in under the cloud
 * host, marked so the reader knows the transcript is out of reach for now.
 *
 * Pure: the hosts are answered by the caller, so the rule is testable without a
 * registry or a socket.
 */

export interface SessionHomeHosts {
  isCloudHost(serverId: string | null | undefined): boolean
  isConnected(serverId: string | null | undefined): boolean
}

export interface SessionHomeRow {
  sessionId?: string | null
  serverId: string | null
  /** The row is the cloud record and no connected runner holds the transcript. */
  runnerOffline?: boolean
}

/** The list in first-seen order: a session's homes gathered under one entry, a row with no session as itself. */
type HomeEntry<Row> = { sessionId: string; homes: Row[] } | { sessionId: null; row: Row }

export function mergeSessionHomes<Row extends SessionHomeRow>(rows: readonly Row[], hosts: SessionHomeHosts): Row[] {
  const groups = new Map<string, Row[]>()
  const order: HomeEntry<Row>[] = []
  for (const row of rows) {
    if (!row.sessionId) {
      order.push({ sessionId: null, row })
      continue
    }
    const group = groups.get(row.sessionId)
    if (group) group.push(row)
    else {
      const homes = [row]
      groups.set(row.sessionId, homes)
      order.push({ sessionId: row.sessionId, homes })
    }
  }
  const merged: Row[] = []
  for (const entry of order) {
    if (entry.sessionId === null) {
      merged.push(entry.row)
      continue
    }
    const group = entry.homes
    const runners = group.filter((row) => !hosts.isCloudHost(row.serverId))
    const record = group.find((row) => hosts.isCloudHost(row.serverId))
    const connectedRunner = runners.find((row) => hosts.isConnected(row.serverId))
    if (connectedRunner) {
      merged.push(connectedRunner)
      continue
    }
    if (record) {
      merged.push({ ...record, runnerOffline: true })
      continue
    }
    merged.push(runners[0]!)
  }
  return merged
}

/** What the record page says beside its composer: the prompt is taken, and waits. */
export const RUNNER_OFFLINE_NOTE = "This session's runner is offline. A prompt you send waits for it."
