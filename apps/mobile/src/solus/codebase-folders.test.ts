import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import {
  codebaseFolders,
  readFolderCodebases,
  readProjectPageCodebases,
} from "./codebase-folders";
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
    codebase("shop", 10, [
      { installationId: "laptop", path: "/code/shop", name: "shop", container: true },
      ELSEWHERE,
    ]),
  );
  host.phone = new FakePhone(laptop);
  host.mayUse = true;
  // The app reads the codebases of each host from its start.
  host.phone.codebases.watch();
  return laptop;
}

/** The row of the folder on the host that no test connects: this phone does not know that host. */
const elsewhereRow = {
  path: ELSEWHERE.path,
  name: ELSEWHERE.name,
  otherHost: { installationId: ELSEWHERE.installationId, label: null },
};

it("gives T3's repositories section the folders of a codebase, and reads the members because the section shows", async () => {
  const laptop = phoneWithShop();
  const registry = AtomRegistry.make();
  try {
    const folders = codebaseFolders.listFolders({
      environmentId: laptopId,
      input: { codebaseId: "shop" },
    });
    await settle();
    expect(laptop.memberReads).toBe(0);
    const close = registry.mount(folders);
    await settle();
    const answer = registry.get(folders);
    expect(answer.waiting).toBe(false);
    expect(AsyncResult.getOrElse(answer, () => null)).toEqual({
      folders: [
        { path: "/code/shop", name: "shop", state: "plain" },
        { path: "/code/shop/api", name: "api", state: "git", discovered: true },
        elsewhereRow,
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
    expect(rows).toContainEqual({ path: "/code/libs", name: "libs", state: "git" });

    const again = await update({ codebaseId: "shop", trackFolders: [{ path: "/code/libs", name: "libs" }] });
    expect(again._tag).toBe("Failure");

    // The row of a folder on a different host takes out the root of that host, not a path of this one.
    const removed = await update({ codebaseId: "shop", untrackFolders: [elsewhereRow] });
    expect(removed._tag).toBe("Success");
    expect(laptop.copies.get("shop")?.roots.map((root) => root.path)).toEqual([
      "/code/shop",
      "/code/libs",
    ]);
    const removedHere = await update({ codebaseId: "shop", untrackFolders: [{ path: "/code/libs" }] });
    expect(removedHere._tag).toBe("Success");
    // The container is the one folder that is left: the codebase cannot be without it.
    const last = await update({ codebaseId: "shop", untrackFolders: [{ path: "/code/shop" }] });
    expect(last._tag).toBe("Failure");

    // A connection that lost the permission to use the host makes no change.
    host.mayUse = false;
    const refused = await update({ codebaseId: "shop", trackFolders: [{ path: "~/libs", name: "libs" }] });
    expect(refused._tag).toBe("Failure");
    expect(laptop.copies.get("shop")?.roots).toHaveLength(1);
    close();
  } finally {
    registry.dispose();
  }
});

it("gives a screen the same answer until the codebases change", async () => {
  // WHY: a screen reads these answers as store snapshots. A new object for the same answer draws it again.
  phoneWithShop();
  await settle();
  const checkouts = [{ hostId: "laptop", path: "/code/shop/api" }];
  const folder = readFolderCodebases("laptop", "/code/shop/api");
  const page = readProjectPageCodebases(checkouts);
  expect(folder.map((entry) => entry.id)).toEqual(["shop"]);
  expect(page.sections.map((section) => section.codebase.id)).toEqual(["shop"]);
  expect(readFolderCodebases("laptop", "/code/shop/api")).toBe(folder);
  expect(readProjectPageCodebases([...checkouts])).toBe(page);

  await phone().codebases.rename("shop", "Shop web");
  expect(readFolderCodebases("laptop", "/code/shop/api")[0]?.name).toBe("Shop web");
  expect(readProjectPageCodebases(checkouts).sections[0]?.codebase.name).toBe("Shop web");
});
