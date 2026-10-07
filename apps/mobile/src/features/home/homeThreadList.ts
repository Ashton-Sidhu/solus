// Adapted from T3 Code apps/mobile/src/features/home/homeThreadList.ts (MIT, see UPSTREAM.md).
import type { SolusProjectShell, SolusThreadShell } from "../threads/thread-directory";
import { groupProjectScopes, type ProjectScope } from "../threads/new-task-project-selection";
import { threadProjectKey } from "../threads/threadListV2";

/** The Home project filter's scopes: every project, or only those on one host. */
export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<SolusProjectShell>;
  readonly hostId: string | null;
}): ReadonlyArray<ProjectScope> {
  return groupProjectScopes(
    input.hostId === null
      ? input.projects
      : input.projects.filter((project) => project.hostId === input.hostId),
  );
}

/** Most recently active project first; a project with no thread sorts by when it was added. */
export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<ProjectScope>;
  readonly threads: ReadonlyArray<SolusThreadShell>;
  readonly knownProjectKeys: ReadonlySet<string>;
}): ReadonlyArray<ProjectScope> {
  const scopeKeyByProjectKey = new Map(
    input.scopes.flatMap((scope) =>
      Array.from(scope.projectKeys, (projectKey) => [projectKey, scope.key] as const),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  for (const thread of input.threads) {
    const scopeKey = scopeKeyByProjectKey.get(threadProjectKey(thread, input.knownProjectKeys));
    if (!scopeKey) continue;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, thread.record.lastActivityAt),
    );
  }
  const addedAt = (scope: ProjectScope) =>
    Math.max(...scope.projects.map((project) => Date.parse(project.project.addedAt) || 0));
  return [...input.scopes].sort((left, right) => {
    const byActivity =
      (latestActivityByScope.get(right.key) ?? addedAt(right)) -
      (latestActivityByScope.get(left.key) ?? addedAt(left));
    if (byActivity !== 0) return byActivity;
    return left.title.localeCompare(right.title) || left.key.localeCompare(right.key);
  });
}
