import { suggestedTrackedFolders } from "@t3tools/client-runtime/state/projects";
import { expect, it } from "vite-plus/test";
import {
  codebaseFolderRowKey,
  codebaseFolderRows,
  codebaseMembersOf,
  codebaseScannedFolders,
  projectPageCodebases,
} from "./codebase-rows";
import { codebase, FakeHost, FakePhone, settle } from "./codebases.test-support";

async function phoneWithShop() {
  const laptop = new FakeHost("laptop", "installation-laptop");
  const server = new FakeHost("server", "installation-server");
  laptop.disk.set("/code/shop", {
    state: "plain",
    found: ["/code/shop/api", "/code/shop/web"],
    suggestions: [
      { path: "/code/libs", name: "libs" },
      { path: "/code/notes", name: "notes" },
    ],
  });
  laptop.disk.set("/code/notes", { state: "plain" });
  server.disk.set("/code/notes", { state: "git" });
  laptop.copies.set(
    "shop",
    codebase("shop", 10, [
      { installationId: "installation-laptop", path: "/code/shop", name: "shop", container: true },
      { installationId: "installation-laptop", path: "/code/notes", name: "notes" },
      { installationId: "installation-laptop", path: "/code/gone", name: "gone" },
      { installationId: "installation-server", path: "/code/notes", name: "notes" },
      { installationId: "installation-unknown", path: "/work/tools", name: "tools" },
    ]),
  );
  const phone = new FakePhone(laptop, server);
  const stops = [phone.codebases.watch()];
  await settle();
  return { phone, laptop, server, stops };
}

it("gives one section the folders of a codebase: those on its host, then those on each other host", async () => {
  const { phone, server, stops } = await phoneWithShop();
  const rows = () => codebaseFolderRows(phone.codebases.membersOf("shop"), "laptop");
  const onServer = { installationId: "installation-server", label: "Host server" };
  const onUnknown = { installationId: "installation-unknown", label: null };

  // Before a host reads its disk, the roots of the record show with no state.
  expect(rows()).toEqual([
    { path: "/code/shop", name: "shop" },
    { path: "/code/notes", name: "notes" },
    { path: "/code/gone", name: "gone" },
    { path: "/code/notes", name: "notes", otherHost: onServer },
    { path: "/work/tools", name: "tools", otherHost: onUnknown },
  ]);

  stops.push(phone.codebases.watchMembers("shop"));
  await settle();
  // The repositories that the host found in the container come after it. A found row has
  // `discovered`, so it gets no Remove button. A root on a host that this phone does not know stays.
  expect(rows()).toEqual([
    { path: "/code/shop", name: "shop", state: "plain" },
    { path: "/code/shop/api", name: "api", state: "git", discovered: true },
    { path: "/code/shop/web", name: "web", state: "git", discovered: true },
    { path: "/code/notes", name: "notes", state: "plain" },
    { path: "/code/gone", name: "gone", state: "missing" },
    { path: "/code/notes", name: "notes", state: "git", otherHost: onServer },
    { path: "/work/tools", name: "tools", otherHost: onUnknown },
  ]);
  // Two hosts have a folder at the same path: each row has its own key.
  expect(new Set(rows().map(codebaseFolderRowKey)).size).toBe(rows().length);

  // The same codebase from the server: its folder is first, and the folders of the laptop name the laptop.
  const fromServer = codebaseFolderRows(phone.codebases.membersOf("shop"), "server");
  expect(fromServer[0]).toEqual({ path: "/code/notes", name: "notes", state: "git" });
  expect(fromServer[1]).toMatchObject({
    path: "/code/shop",
    otherHost: { installationId: "installation-laptop", label: "Host laptop" },
  });

  // A host that is away keeps its row with its last answer.
  server.isReady = false;
  await phone.changed();
  expect(rows()).toContainEqual({
    path: "/code/notes",
    name: "notes",
    state: "git",
    otherHost: onServer,
  });
  for (const stop of stops) stop();
});

it("offers a folder of a workspace file only while it is not a root on that host", async () => {
  const { phone, stops } = await phoneWithShop();
  stops.push(phone.codebases.watchMembers("shop"));
  await settle();
  const hosts = phone.codebases.membersOf("shop");
  const onLaptop = hosts.find((host) => host.hostId === "laptop");

  const scanned = codebaseScannedFolders(onLaptop);
  expect(scanned).toEqual([
    { path: "/code/libs", name: "libs", isGitRepository: false, source: "code-workspace" },
  ]);
  const laptopRows = codebaseFolderRows(hosts, "laptop").filter((row) => !row.otherHost);
  expect(suggestedTrackedFolders(laptopRows, scanned)).toEqual([
    { path: "/code/libs", name: "libs" },
  ]);
  expect(codebaseScannedFolders(undefined)).toEqual([]);
  // The members that a new worktree reads: the roots that the host read, and the repositories of the container.
  expect(codebaseMembersOf(onLaptop)?.map((member) => member.path)).toEqual([
    "/code/shop",
    "/code/shop/api",
    "/code/shop/web",
    "/code/notes",
    "/code/gone",
  ]);
  expect(codebaseMembersOf(undefined)).toBeNull();
  for (const stop of stops) stop();
});

it("gives the project page one section for each codebase, and a way to make one for a checkout in none", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.disk.set("/code/shop", { state: "git" });
  laptop.disk.set("/libs/ui", { state: "git" });
  server.disk.set("/srv/shop", { state: "git" });
  const phone = new FakePhone(laptop, server);
  const checkouts = [
    { hostId: "laptop", path: "/code/shop" },
    { hostId: "server", path: "/srv/shop" },
  ];
  const page = () => projectPageCodebases(phone.codebases, checkouts);

  // The list of a host is not read: the page must not offer a new codebase yet.
  expect(page()).toMatchObject({ sections: [], loose: [] });
  const stop = phone.codebases.watch();
  await settle();
  // In no codebase: each checkout can make one, and the row can name its host.
  expect(page().loose).toEqual([
    { hostId: "laptop", path: "/code/shop", hostLabel: "Host laptop" },
    { hostId: "server", path: "/srv/shop", hostLabel: "Host server" },
  ]);
  expect(page().readyHosts).toEqual([
    { hostId: "laptop", label: "Host laptop" },
    { hostId: "server", label: "Host server" },
  ]);

  // A codebase that holds the two checkouts is one section, not one for each host.
  const shop = await phone.codebases.create("Shop", [
    { hostId: "laptop", path: "/code/shop" },
    { hostId: "server", path: "/srv/shop" },
  ]);
  expect(page().sections).toEqual([
    { codebase: phone.codebases.codebaseOf(shop.id), hostId: "laptop" },
  ]);
  expect(page().loose).toEqual([]);

  // One folder can be in several codebases: each one is a section, by name.
  await phone.codebases.create("All UI", [
    { hostId: "laptop", path: "/code/shop" },
    { hostId: "laptop", path: "/libs/ui" },
  ]);
  expect(page().sections.map((section) => section.codebase.name)).toEqual(["All UI", "Shop"]);

  await phone.codebases.delete(shop.id);
  expect(page().sections.map((section) => section.codebase.name)).toEqual(["All UI"]);
  // The checkout on the server is in no codebase again.
  expect(page().loose.map((checkout) => checkout.hostId)).toEqual(["server"]);

  // A host that is away gets no new folder.
  server.isReady = false;
  await phone.changed();
  expect(page().readyHosts).toEqual([{ hostId: "laptop", label: "Host laptop" }]);
  stop();
});
