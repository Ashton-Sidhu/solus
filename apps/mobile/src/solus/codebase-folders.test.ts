import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { codebaseFolders, readProjectCodebases } from "./codebase-folders";
import { codebase, ELSEWHERE, FakeHost, FakePhone, settle } from "./codebases.test-support";

interface MockedRuntime {
  phone: FakePhone | null;
  mayUse: boolean;
}
const host: MockedRuntime = vi.hoisted(() => ({ phone: null, mayUse: true }));
function phone(): FakePhone {
  if (!host.phone) throw new Error("The test did not make a phone.");
  return host.phone;
}
vi.mock("./runtime", () => ({
  solus: {
    get codebases() {
      return phone().codebases;
    },
    connections: {
      may: () => host.mayUse,
      state: () => ({ readiness: "ready", sessionGeneration: 1 }),
      changes: { subscribe: () => () => {} },
    },
    sessionCache: { scope: () => phone().scope },
    account: { changes: { subscribe: () => () => {} } },
  },
}));

const laptopId = EnvironmentId.make("laptop");

function phoneWithShop() {
  const laptop = new FakeHost("laptop");
  laptop.disk.set("/code/shop", { state: "plain", found: ["/code/shop/api"] });
  laptop.disk.set("/code/libs", { state: "git" });
  laptop.resolved.set("~/libs", "/code/libs");
  laptop.copies.set(
    "shop",
    codebase("shop", 10, [{ installationId: "laptop", path: "/code/shop", name: "shop" }, ELSEWHERE]),
  );
  host.phone = new FakePhone(laptop);
  host.mayUse = true;
  return laptop;
}

it("gives T3's repositories section the members of a codebase, and reads them because the section shows", async () => {
  const laptop = phoneWithShop();
  const registry = AtomRegistry.make();
  try {
    const folders = codebaseFolders.listFolders({
      environmentId: laptopId,
      input: { codebaseId: "shop" },
    });
    const close = registry.mount(folders);
    await settle();
    const answer = registry.get(folders);
    expect(answer.waiting).toBe(false);
    expect(AsyncResult.getOrElse(answer, () => null)).toEqual({
      folders: [
        { path: "/code/shop", name: "shop", state: "plain" },
        { path: "/code/shop/api", name: "api", state: "git", discovered: true },
      ],
    });
    // A refresh reads the disk of the host again. An answer that says the same keeps the same rows.
    const reads = laptop.memberReads;
    registry.refresh(folders);
    await settle();
    expect(laptop.memberReads).toBe(reads + 1);
    expect(AsyncResult.getOrElse(registry.get(folders), () => null)).toBe(
      AsyncResult.getOrElse(answer, () => null),
    );
    close();
  } finally {
    registry.dispose();
  }
});

it("adds a folder through the scan of its host and takes a root out, as one change of T3's section", async () => {
  const laptop = phoneWithShop();
  const registry = AtomRegistry.make();
  try {
    const folders = codebaseFolders.listFolders({
      environmentId: laptopId,
      input: { codebaseId: "shop" },
    });
    const close = registry.mount(folders);
    await settle();
    const update = (input: Parameters<typeof codebaseFolders.update.run>[1]["input"]) =>
      runAtomCommand(registry, codebaseFolders.update, { environmentId: laptopId, input }, {
        reportFailure: false,
      });

    const added = await update({ codebaseId: "shop", trackFolders: [{ path: "~/libs", name: "libs" }] });
    expect(added._tag).toBe("Success");
    expect(laptop.copies.get("shop")?.roots.map((root) => root.path)).toEqual([
      "/code/shop",
      ELSEWHERE.path,
      "/code/libs",
    ]);
    await settle();
    const rows = AsyncResult.getOrElse(registry.get(folders), () => null)?.folders;
    expect(rows?.at(-1)).toEqual({ path: "/code/libs", name: "libs", state: "git" });

    const again = await update({ codebaseId: "shop", trackFolders: [{ path: "/code/libs", name: "libs" }] });
    expect(again._tag).toBe("Failure");

    const removed = await update({ codebaseId: "shop", untrackFolders: ["/code/shop"] });
    expect(removed._tag).toBe("Success");
    expect(laptop.copies.get("shop")?.roots.map((root) => root.path)).toEqual([
      ELSEWHERE.path,
      "/code/libs",
    ]);
    // A codebase has two or more folders: one of the last two stays.
    const lastTwo = await update({ codebaseId: "shop", untrackFolders: ["/code/libs"] });
    expect(lastTwo._tag).toBe("Failure");

    // A connection that lost the permission to use the host makes no change.
    host.mayUse = false;
    const refused = await update({ codebaseId: "shop", untrackFolders: ["/code/libs"] });
    expect(refused._tag).toBe("Failure");
    expect(laptop.copies.get("shop")?.roots).toHaveLength(2);
    close();
  } finally {
    registry.dispose();
  }
});

it("gives the project overview the same answer until the codebases change", async () => {
  phoneWithShop();
  const stop = phone().codebases.watch();
  await settle();
  const first = readProjectCodebases("laptop", "/code/shop");
  expect(first.sections.map((section) => section.codebase.id)).toEqual(["shop"]);
  expect(readProjectCodebases("laptop", "/code/shop")).toBe(first);

  await phone().codebases.rename("shop", "Shop web");
  const renamed = readProjectCodebases("laptop", "/code/shop");
  expect(renamed).not.toBe(first);
  expect(renamed.sections[0]?.codebase.name).toBe("Shop web");
  stop();
});
