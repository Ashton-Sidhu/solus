// Adapted from T3 Code apps/mobile/src/features/home/homeThreadList.ts (MIT, see UPSTREAM.md).
import type { SolusProjectShell, SolusThreadShell } from "../threads/thread-directory";
import { threadProjectKey } from "../threads/threadListV2";

/**
 * One entry of the Home project filter. T3 groups an environment's projects
 * by repository; Solus does the same with `ProjectEntry.repositoryKey`, so
 * one repository checked out on two hosts is one scope. A folder with no
 * hosted remote is its own scope.
 */
export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: SolusProjectShell;
  readonly projects: ReadonlyArray<SolusProjectShell>;
  /** `SolusProjectShell.key` of every member. */
  readonly projectKeys: ReadonlySet<string>;
}

export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<SolusProjectShell>;
  readonly hostId: string | null;
}): ReadonlyArray<HomeProjectScope> {
  const groups = new Map<string, SolusProjectShell[]>();
  for (const project of input.projects) {
    if (input.hostId !== null && project.hostId !== input.hostId) continue;
    const key = project.project.repositoryKey
      ? `repository:${project.project.repositoryKey}`
      : `project:${project.key}`;
    const members = groups.get(key) ?? [];
    members.push(project);
    groups.set(key, members);
  }
  return Array.from(groups, ([key, members]) => {
    const representative = members[0]!;
    return {
      key,
      title: representative.project.folderName,
      representative,
      projects: members,
      projectKeys: new Set(members.map((member) => member.key)),
    };
  });
}

/** Most recently active project first; a project with no thread sorts by when it was added. */
export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<SolusThreadShell>;
  readonly knownProjectKeys: ReadonlySet<string>;
}): ReadonlyArray<HomeProjectScope> {
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
  const addedAt = (scope: HomeProjectScope) =>
    Math.max(...scope.projects.map((project) => Date.parse(project.project.addedAt) || 0));
  return [...input.scopes].sort((left, right) => {
    const byActivity =
      (latestActivityByScope.get(right.key) ?? addedAt(right)) -
      (latestActivityByScope.get(left.key) ?? addedAt(left));
    if (byActivity !== 0) return byActivity;
    return left.title.localeCompare(right.title) || left.key.localeCompare(right.key);
  });
}
