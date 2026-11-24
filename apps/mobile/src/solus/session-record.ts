import type { SessionRecord } from "@solus/contracts/types";
import { hostQuery } from "./host-query";
import { usesWindowFilter, visibleInWindow } from "@solus/client-core/organization-filter";
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { hostQueryScope } from "../state/host-query-scope";
import { solus } from "./runtime";

/** A child session or a deep link can name a record outside the first list page. */
export async function rememberSession(hostId: string, sessionId: string, confirmed?: SessionRecord) {
  const known = solus.threads.thread(hostId, sessionId);
  if (
    known &&
    visibleInWindow(
      known.record.organizationId,
      solus.account.organizationId,
      usesWindowFilter(hostId, solus.threads.managedHostIds()),
    )
  )
    return known.record;
  const scope = hostQueryScope(hostId);
  const host = solus.connections.connection(hostId);
  const record = confirmed ?? await host?.api.sessionRecordGet(sessionId);
  if (scope !== hostQueryScope(hostId)) throw new Error("The connection changed.");
  if (
    !record ||
    record.sessionId !== sessionId ||
    !visibleInWindow(
      record.organizationId,
      solus.account.organizationId,
      usesWindowFilter(hostId, solus.threads.managedHostIds()),
    )
  )
    throw new Error("This session is unavailable on this host.");
  solus.threads.rememberSearchResult({
    hostId,
    hostLabel: solus.registry.host(hostId)?.label ?? hostId,
    key: threadKey(hostId, sessionId),
    record,
  });
  return record;
}

// The directory owns remembered records. Release the query when its last reader
// leaves so a later open can recover a record evicted from the directory.
export const linkedSessionRecord = hostQuery(rememberSession, 30_000, 0);
