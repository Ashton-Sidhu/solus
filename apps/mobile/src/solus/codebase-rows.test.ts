import { suggestedTrackedFolders } from "@t3tools/client-runtime/state/projects";
import { expect, it } from "vite-plus/test";
import { codebaseFolderRows, codebaseScannedFolders, projectCodebases } from "./codebase-rows";
import { codebase, FakeHost, FakePhone, settle } from "./codebases.test-support";

async function phoneWithShop() {
  const laptop = new FakeHost("laptop", "installation-laptop");
  const server = new FakeHost("server", "installation-server");
  laptop.disk.set("/code/shop", {
    state: "plain",
    found: ["/code/shop/api"],
    suggestions: [
      { path: "/code/libs", name: "libs" },
      { path: "/code/notes", name: "notes" },
    ],
  });
  laptop.disk.set("/code/notes", { state: "plain" });
  server.disk.set("/srv/infra", { state: "git" });
  laptop.copies.set(
    "shop",
    codebase("shop", 10, [
      { installationId: "installation-laptop", path: "/code/shop", name: "shop" },
      { installationId: "installation-laptop", path: "/code/notes", name: "notes" },
      { installationId: "installation-laptop", path: "/code/gone", name: "gone" },
      { installationId: "installation-server", path: "/srv/infra", name: "infra" },
      { installationId: "installation-unknown", path: "/work/tools", name: "tools" },
    ]),
  );
  const phone = new FakePhone(laptop, server);
  const stops = [phone.codebases.watch()];
  await settle();
  return { phone, laptop, server, stops };
}

it("gives T3's folder rows for the members of a codebase on one host", async () => {
  const { phone, stops } = await phoneWithShop();
  const onLaptop = () => phone.codebases.membersOf("shop").find((host) => host.hostId === "laptop");

  // Before the host reads its disk, the roots of the record show with no state.
  expect(codebaseFolderRows(onLaptop())).toEqual([
    { path: "/code/shop", name: "shop" },
    { path: "/code/notes", name: "notes" },
    { path: "/code/gone", name: "gone" },
  ]);

  stops.push(phone.codebases.watchMembers("shop"));
  await settle();
  // Each root, then the repositories found in it. A found row has `discovered`, so it gets no Remove button.
  expect(codebaseFolderRows(onLaptop())).toEqual([
    { path: "/code/shop", name: "shop", state: "plain" },
    { path: "/code/shop/api", name: "api", state: "git", discovered: true },
    { path: "/code/notes", name: "notes", state: "plain" },
    { path: "/code/gone", name: "gone", state: "missing" },
  ]);

  // A folder that a `.code-workspace` file lists is offered only while it is not a root.
  const scanned = codebaseScannedFolders(onLaptop());
  expect(scanned).toEqual([
    { path: "/code/libs", name: "libs", isGitRepository: false, source: "code-workspace" },
  ]);
  expect(suggestedTrackedFolders(codebaseFolderRows(onLaptop()), scanned)).toEqual([
    { path: "/code/libs", name: "libs" },
  ]);
  expect(codebaseFolderRows(undefined)).toEqual([]);
  for (const stop of stops) stop();
});

it("lists the roots on other hosts, and keeps a root on a host that this phone does not know", async () => {
  const { phone, server, stops } = await phoneWithShop();
  stops.push(phone.codebases.watchMembers("shop"));
  await settle();

  const [section] = projectCodebases(phone.codebases, "laptop", "/code/shop/api").sections;
  expect(section?.codebase.id).toBe("shop");
  expect(section?.folders.map((folder) => folder.path)).toContain("/code/shop/api");
  expect(section?.otherHosts).toEqual([
    {
      installationId: "installation-server",
      hostId: "server",
      label: "Host server",
      presence: "ready",
      isStale: false,
      folders: [{ path: "/srv/infra", name: "infra", state: "git" }],
    },
    {
      installationId: "installation-unknown",
      hostId: null,
      label: null,
      presence: "unknown",
      isStale: false,
      folders: [{ path: "/work/tools", name: "tools" }],
    },
  ]);

  // A host that is away is read-only and shows its last answer.
  server.isReady = false;
  await phone.changed();
  const away = projectCodebases(phone.codebases, "laptop", "/code/shop").sections[0]?.otherHosts[0];
  expect(away).toMatchObject({ presence: "away", isStale: true });
  expect(away?.folders).toEqual([{ path: "/srv/infra", name: "infra", state: "git" }]);
  for (const stop of stops) stop();
});

it("gives the project overview one section for each codebase that holds the project folder", async () => {
  const laptop = new FakeHost("laptop");
  laptop.disk.set("/code/shop", { state: "git" });
  const phone = new FakePhone(laptop);
  // The list of the host is not read: the screen must not offer a new codebase yet.
  expect(projectCodebases(phone.codebases, "laptop", "/code/shop")).toEqual({
    status: null,
    sections: [],
  });
  const stop = phone.codebases.watch();
  await settle();

  // In no codebase: the screen offers "Make a codebase".
  expect(projectCodebases(phone.codebases, "laptop", "/code/shop")).toEqual({
    status: "ready",
    sections: [],
  });

  laptop.disk.set("/libs/ui", { state: "git" });
  const shop = await phone.codebases.create("Shop", [
    { hostId: "laptop", path: "/code/shop" },
    { hostId: "laptop", path: "/libs/ui" },
  ]);
  const one = projectCodebases(phone.codebases, "laptop", "/code/shop");
  expect(one.sections.map((section) => section.codebase.name)).toEqual(["Shop"]);
  expect(one.sections[0]?.folders).toEqual([
    { path: "/code/shop", name: "shop" },
    { path: "/libs/ui", name: "ui" },
  ]);
  expect(one.sections[0]?.otherHosts).toEqual([]);

  // One folder can be in several codebases: each one is a section, by name.
  laptop.disk.set("/code", { state: "plain", found: ["/code/shop"] });
  await phone.codebases.create("All code", [
    { hostId: "laptop", path: "/code" },
    { hostId: "laptop", path: "/libs/ui" },
  ]);
  const two = projectCodebases(phone.codebases, "laptop", "/code/shop");
  expect(two.sections.map((section) => section.codebase.name)).toEqual(["All code", "Shop"]);
  // A folder outside each root is in no codebase.
  expect(projectCodebases(phone.codebases, "laptop", "/elsewhere").sections).toEqual([]);

  await phone.codebases.delete(shop.id);
  const afterDelete = projectCodebases(phone.codebases, "laptop", "/code/shop");
  expect(afterDelete.sections.map((section) => section.codebase.name)).toEqual(["All code"]);
  stop();
});
