import type { ManagedWorktree } from "@solus/contracts/git-types";
import {
  keptBranchNotice,
  removeConfirmedWorktrees,
  worktreeRemovalError,
} from "@solus/client-core/managed-worktrees";
import { hostQueryScope } from "../state/host-query-scope";
import { hostCommand } from "./host-command";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";

export const managedWorktrees = hostQuery(async (hostId, _input: null) => {
  const api = solus.connections.connection(hostId)?.api;
  if (!api) throw new Error("Host disconnected.");
  return api.managedWorktreesList();
}, 0);

export const removeManagedWorktrees = hostCommand(
  "worktrees:remove",
  "host.git.write",
  async (environmentId, input: { scope: string; worktrees: readonly ManagedWorktree[] }, registry, check) => {
    const api = solus.connections.connection(environmentId)?.api;
    if (!api || input.scope !== hostQueryScope(environmentId)) {
      throw new Error("The host connection changed. Select the worktrees again.");
    }

    const guardedApi = {
      managedWorktreeRemove: (...args: Parameters<typeof api.managedWorktreeRemove>) => {
        check();
        return api.managedWorktreeRemove(...args);
      },
    };
    let removed = 0;
    const notices: string[] = [];
    const failures: { path: string; message: string }[] = [];
    try {
      for await (const { worktree, result } of removeConfirmedWorktrees(guardedApi, input.worktrees)) {
        check();
        if (result.status === "removed") {
          removed++;
          if (result.branchError) notices.push(keptBranchNotice(worktree, result.branchError));
        } else {
          failures.push({ path: worktree.path, message: `${worktree.title}. ${worktreeRemovalError(result)}` });
        }
      }
      return { removed, notices, failures };
    } finally {
      registry.refresh(managedWorktrees({ environmentId, input: null, scope: input.scope }));
    }
  },
);
