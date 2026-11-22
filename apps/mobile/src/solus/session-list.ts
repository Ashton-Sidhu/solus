import type { SolusThreadShell } from "@solus-mobile/features/threads/thread-directory";
import type { ThreadListV2Facts } from "@solus-mobile/features/threads/threadListV2";
import type { SessionStarter } from "@solus/contracts/types";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { sameItems } from "@solus/client-core/keep-equal";
import { toThreadShell, type SessionRow } from "./session";

export type SessionListThread = EnvironmentThreadShell & { automationName?: string | null };

export function createSessionListProjection() {
  const cache = new WeakMap<
    SessionRow,
    {
      hostId: string;
      view: SessionRow["view"];
      state: SessionRow["state"];
      pinnedAt: number | undefined;
      automationName: string | null | undefined;
      shell: SessionListThread;
    }
  >();
  let previous: SessionListThread[] = [];
  return (
    rows: ReadonlyArray<
      Pick<SolusThreadShell, "hostId" | "key"> & {
        record: SessionRow & { startedBy?: SessionStarter | null };
      }
    >,
    facts: Pick<ThreadListV2Facts, "views" | "states" | "pins">,
    automationNames?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ) => {
    const next = rows.map(({ hostId, record, key }) => {
      const view = facts.views.get(key) ?? record.view;
      const state = facts.states.get(key) ?? record.state;
      const pinnedAt = facts.pins?.get(key)?.pinnedAt;
      const starter = record.startedBy;
      const automationName = starter?.kind === "automation"
        ? (automationNames?.get(hostId)?.get(starter.automationId) ?? null)
        : undefined;
      const held = cache.get(record);
      if (
        held &&
        held.hostId === hostId &&
        held.view === view &&
        held.state === state &&
        held.pinnedAt === pinnedAt &&
        held.automationName === automationName
      )
        return held.shell;
      const shell: SessionListThread = toThreadShell(hostId, record, undefined, view, state, pinnedAt);
      if (automationName !== undefined) shell.automationName = automationName;
      cache.set(record, { hostId, view, state, pinnedAt, automationName, shell });
      return shell;
    });
    if (!sameItems(previous, next)) previous = next;
    return previous;
  };
}
