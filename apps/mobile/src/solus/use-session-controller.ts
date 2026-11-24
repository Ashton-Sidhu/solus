import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import type { SessionFolder } from "@solus/contracts/codebases";
import { useListened } from "@solus-mobile/app/app-context";
import { solus } from "./runtime";
import { sessionDetailAtom } from "./session-detail";

export function useSessionStore(params: { environmentId: string; threadId: string }) {
  useListened(solus.account.changes, solus.sessionCache.scope);
  return useAtomValue(sessionDetailAtom(params.environmentId, params.threadId));
}

export function useSessionController(params: { environmentId: string; threadId: string }) {
  return useSessionStore(params)?.controller;
}

const NO_FOLDERS: readonly SessionFolder[] = Object.freeze([]);
const noStore = () => () => {};

/** The folders that the session works in besides its working directory, as its host last gave them. */
export function useSessionFolders(params: {
  environmentId: string;
  threadId: string;
}): readonly SessionFolder[] {
  const store = useAtomValue(sessionDetailAtom(params.environmentId, params.threadId));
  return useSyncExternalStore(
    store?.meta.subscribe ?? noStore,
    () => store?.metaSnapshotOf().sessionFolders ?? NO_FOLDERS,
  );
}
