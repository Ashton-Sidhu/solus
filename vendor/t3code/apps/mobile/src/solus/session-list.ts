import type { SolusThreadShell } from "@solus-mobile/features/threads/thread-directory";
import type { ThreadListV2Facts } from "@solus-mobile/features/threads/threadListV2";
import { sameItems } from "@solus/client-core/keep-equal";
import { toThreadShell, type SessionRow } from "./session";

export function createSessionListProjection() {
  type Shell = ReturnType<typeof toThreadShell>;
  const cache = new WeakMap<
    SessionRow,
    {
      hostId: string;
      view: SessionRow["view"];
      state: SessionRow["state"];
      pinnedAt: number | undefined;
      shell: Shell;
    }
  >();
  let previous: Shell[] = [];
  return (
    rows: ReadonlyArray<Pick<SolusThreadShell, "hostId" | "key"> & { record: SessionRow }>,
    facts: Pick<ThreadListV2Facts, "views" | "states" | "pins">,
  ) => {
    const next = rows.map(({ hostId, record, key }) => {
      const view = facts.views.get(key) ?? record.view;
      const state = facts.states.get(key) ?? record.state;
      const pinnedAt = facts.pins?.get(key)?.pinnedAt;
      const held = cache.get(record);
      if (
        held &&
        held.hostId === hostId &&
        held.view === view &&
        held.state === state &&
        held.pinnedAt === pinnedAt
      )
        return held.shell;
      const shell = toThreadShell(hostId, record, undefined, view, state, pinnedAt);
      cache.set(record, { hostId, view, state, pinnedAt, shell });
      return shell;
    });
    if (!sameItems(previous, next)) previous = next;
    return previous;
  };
}
