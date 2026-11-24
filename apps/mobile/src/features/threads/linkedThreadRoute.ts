import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type LinkedThreadRouteParams = {
  readonly viaEnvironmentId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly label: string;
  readonly title?: string;
  readonly parentSessionId?: string;
};

/** The route params that open a linked environment's thread read-only. */
export const linkedThreadRouteParams = (
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  linked: { readonly viaEnvironmentId: EnvironmentId; readonly label: string; readonly parentSessionId?: string },
  title: string | null,
): LinkedThreadRouteParams => ({
  viaEnvironmentId: linked.viaEnvironmentId,
  environmentId: thread.environmentId,
  threadId: thread.threadId,
  label: linked.label,
  ...(linked.parentSessionId === undefined ? {} : { parentSessionId: linked.parentSessionId }),
  ...(title === null ? {} : { title }),
});
