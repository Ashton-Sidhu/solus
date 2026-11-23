import { useAtomValue } from "@effect/atom-react";
import { useListened } from "@solus-mobile/app/app-context";
import { solus } from "./runtime";
import { sessionDetailAtom } from "./session-detail";

export function useSessionController(params: { environmentId: string; threadId: string }) {
  useListened(solus.account.changes, solus.sessionCache.scope);
  const store = useAtomValue(sessionDetailAtom(params.environmentId, params.threadId));
  return store?.controller;
}
