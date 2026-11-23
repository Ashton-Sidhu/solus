import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { listCheckoutRefs } from "./checkout-refs";

const calls = vi.hoisted(() => ({
  gitRepositoryStatus: vi.fn(async () => ({
    isRepository: true,
    primaryRemoteName: "origin",
    branch: "topic",
  })),
  worktreeBranches: vi.fn(async () => [
    { name: "work", isDefault: false, remoteOnly: false, worktreePath: "/other" },
    { name: "main", isDefault: true, remoteOnly: false },
    { name: "topic", isDefault: false, remoteOnly: false },
  ]),
}));
vi.mock("./runtime", () => {
  const changes = { subscribe: () => () => {} };
  return {
    solus: {
      account: { organizationId: "org", changes },
      sessionCache: { scope: () => "org" },
      connections: {
        state: () => ({ sessionGeneration: 1 }),
        connection: () => ({ api: calls }),
        may: () => true,
        changes,
      },
    },
  };
});
it("serves search and remaining branch pages from one host read of the checkout", async () => {
  const registry = AtomRegistry.make();
  const environmentId = EnvironmentId.make("mac");
  const read = (input: { cursor?: number; query?: string }) =>
    executeAtomQuery(
      registry,
      listCheckoutRefs({ environmentId, input: { cwd: "/repo", limit: 1, ...input } }),
    );
  try {
    expect(await read({})).toMatchObject({
      value: { refs: [{ name: "topic", current: true }], nextCursor: 1 },
    });
    expect(await read({ cursor: 1 })).toMatchObject({
      value: { refs: [{ name: "main", isDefault: true }], nextCursor: 2 },
    });
    expect(await read({ query: "WORK" })).toMatchObject({
      value: { refs: [{ name: "work", worktreePath: "/other" }], nextCursor: null },
    });
    expect(calls.gitRepositoryStatus).toHaveBeenCalledTimes(1);
    expect(calls.worktreeBranches).toHaveBeenCalledTimes(1);
  } finally {
    registry.dispose();
  }
});
