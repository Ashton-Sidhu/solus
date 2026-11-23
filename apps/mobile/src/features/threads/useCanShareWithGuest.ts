import { useAtomValue } from "@effect/atom-react";
import { resourceAllows } from "@solus/contracts/permissions";
import type { EnvironmentId } from "@t3tools/contracts";
import { solus, solusDirectoryAtom } from "../../solus/runtime";

export function useCanShareWithGuest(
  environmentId: EnvironmentId | null,
  threadId: string | undefined,
): boolean {
  return useAtomValue(
    solusDirectoryAtom,
    (directory) =>
      environmentId !== null &&
      !!threadId &&
      directory.listHosts.connectedEnvironmentIds.has(environmentId) &&
      resourceAllows({ role: solus.threads.thread(environmentId, threadId)?.record.role }, "share"),
  );
}
