import { EnvironmentId } from "@t3tools/contracts";
import type { ManagedWorktree, ManagedWorktreeRemoveResult } from "@solus/contracts/git-types";
import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { hostCommand } from "./host-command";
import { hostQuery } from "./host-query";
import { hostQueryScope } from "../state/host-query-scope";
import { removeManagedWorktrees } from "./managed-worktrees";

const state = vi.hoisted(() => ({
  account: "one",
  generation: 1,
  listeners: new Set<() => void>(),
  removeWorktree: vi.fn<() => Promise<ManagedWorktreeRemoveResult>>(),
  listWorktrees: vi.fn<() => Promise<ManagedWorktree[]>>(),
}));
vi.mock("./runtime", () => {
  const changes = {
    subscribe(listener: () => void) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  return {
    solus: {
      sessionCache: { scope: () => state.account },
      account: { changes },
      connections: {
        state: () => ({ sessionGeneration: state.generation, readiness: "ready" }),
        may: () => true,
        connection: () => ({ api: {
          managedWorktreesList: state.listWorktrees,
          managedWorktreeRemove: state.removeWorktree,
        } }),
        changes,
      },
    },
  };
});

const target = { environmentId: EnvironmentId.make("mac"), input: null };
afterEach(() => {
  state.account = "one";
  state.generation = 1;
  state.listWorktrees.mockReset();
  state.removeWorktree.mockReset();
});

it("shares a warm host answer and keeps unchanged rows across a refresh", async () => {
  const read = vi.fn(async () => [{ title: "PR" }]);
  const query = hostQuery(read);
  const registry = AtomRegistry.make();
  try {
    const first = await executeAtomQuery(registry, query(target));
    const warm = await executeAtomQuery(registry, query(target));
    expect(read).toHaveBeenCalledTimes(1);
    const refreshed = await executeAtomQuery(registry, query(target), { refresh: true });
    expect(read).toHaveBeenCalledTimes(2);
    if (first._tag !== "Success" || warm._tag !== "Success" || refreshed._tag !== "Success")
      throw new Error("Read failed");
    expect(warm.value).toBe(first.value);
    expect(refreshed.value).toBe(first.value);
  } finally {
    registry.dispose();
  }
});

it.each(["account", "connection"])(
  "drops an unfinished read after a change of %s",
  async (change) => {
    const old = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const query = hostQuery(
      vi
        .fn()
        .mockImplementationOnce(() => {
          started.resolve();
          return old.promise;
        })
        .mockResolvedValue("current"),
    );
    const registry = AtomRegistry.make();
    const source = query(target);
    const unmount = registry.mount(source);
    try {
      await started.promise;
      if (change === "account") state.account = "two";
      else state.generation++;
      for (const listener of [...state.listeners]) listener();
      const next = await executeAtomQuery(registry, source);
      expect(next).toMatchObject({ _tag: "Success", value: "current" });
      old.resolve("old");
      await old.promise;
      expect(AsyncResult.getOrElse(registry.get(source), () => null)).toBe("current");
    } finally {
      unmount();
      registry.dispose();
    }
  },
);

it("checks the account again before a queued edit reaches the host", async () => {
  const running = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: string[] = [];
  const edit = hostCommand("test.edit", "host.git.write", async (_id, input: string) => {
    writes.push(input);
    running.resolve();
    await release.promise;
  });
  const registry = AtomRegistry.make();
  try {
    const first = runAtomCommand(registry, edit, { ...target, input: "first" });
    await running.promise;
    const second = runAtomCommand(
      registry,
      edit,
      { ...target, input: "second" },
      { reportFailure: false },
    );
    state.account = "two";
    release.resolve();
    expect((await first)._tag).toBe("Success");
    expect((await second)._tag).toBe("Failure");
    expect(writes).toEqual(["first"]);
  } finally {
    registry.dispose();
  }
});

it("stops a confirmed worktree batch if the host reconnects midway", async () => {
  const started = Promise.withResolvers<void>();
  const firstRemoval = Promise.withResolvers<ManagedWorktreeRemoveResult>();
  const worktree = (path: string): ManagedWorktree => ({
    path,
    kind: "worktree",
    group: { key: "project", name: "Project", detail: "/project" },
    title: path,
    branch: null,
    hasUncommittedWork: false,
    hasUnmergedCommits: false,
    sessionId: null,
    sessions: [],
  });
  state.listWorktrees.mockResolvedValue([]);
  state.removeWorktree.mockImplementationOnce(() => {
    started.resolve();
    return firstRemoval.promise;
  });
  const registry = AtomRegistry.make();
  try {
    const removing = runAtomCommand(
      registry,
      removeManagedWorktrees,
      {
        environmentId: target.environmentId,
        input: { scope: hostQueryScope(target.environmentId), worktrees: [worktree("/first"), worktree("/second")] },
      },
      { reportFailure: false },
    );
    await started.promise;
    state.generation++;
    firstRemoval.resolve({ status: "removed" });

    expect((await removing)._tag).toBe("Failure");
    expect(state.removeWorktree).toHaveBeenCalledExactlyOnceWith("/first", { force: false });
  } finally {
    registry.dispose();
  }
});
