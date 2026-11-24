import { CodebaseRootRefused } from "@solus/client-core/codebases";
import { CODEBASE_ROOTS_MAX } from "@solus/contracts/codebases";
import { expect, it, vi } from "vite-plus/test";
import { codebase, FakeHost, FakePhone, settle } from "./codebases.test-support";

it("sends the newest copy one time to a host that has an older one", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.copies.set("shop", codebase("shop", 20));
  server.copies.set("shop", codebase("shop", 10));
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();

  expect(phone.codebases.codebases().map((entry) => entry.updatedAt)).toEqual([20]);
  expect(server.saves.map((copy) => copy.updatedAt)).toEqual([20]);
  expect(laptop.saves).toEqual([]);

  // A second read of each host finds the same copies: nothing is sent.
  await Promise.all([phone.codebases.load("laptop"), phone.codebases.load("server")]);
  await settle();
  expect(server.saves).toHaveLength(1);
  expect(laptop.saves).toEqual([]);
  stop();
});

it("does not send a copy again to a host that refuses it, until that host is read again", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.copies.set("shop", codebase("shop", 20));
  server.saveError = "The disk is full.";
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();
  // A read of the other host merges again. The refused copy is not sent a second time.
  await phone.codebases.load("laptop");
  await settle();
  expect(error).toHaveBeenCalledTimes(1);

  server.saveError = null;
  await phone.codebases.load("server");
  await settle();
  expect(server.copies.get("shop")?.updatedAt).toBe(20);
  stop();
  error.mockRestore();
});

it("removes a codebase when a host has its tombstone, and sends the tombstone on", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.copies.set("shop", codebase("shop", 10));
  server.copies.set("shop", codebase("shop", 30, [], 30));
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();

  expect(phone.codebases.codebases()).toEqual([]);
  expect(phone.codebases.codebaseOf("shop")).toBeUndefined();
  expect(laptop.copies.get("shop")?.deletedAt).toBe(30);
  stop();
});

it("gives a host that connects later the copies it does not have", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  server.isReady = false;
  laptop.copies.set("shop", codebase("shop", 20));
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();
  expect(server.listReads).toBe(0);
  expect(server.saves).toEqual([]);

  server.isReady = true;
  await phone.changed();
  expect(server.listReads).toBe(1);
  expect(server.copies.get("shop")?.updatedAt).toBe(20);
  stop();
});

it("reads a host again when a different client changes a codebase there", async () => {
  const laptop = new FakeHost("laptop");
  const phone = new FakePhone(laptop);
  const stop = phone.codebases.watch();
  await settle();
  expect(phone.codebases.codebases()).toEqual([]);

  laptop.copies.set("shop", codebase("shop", 5));
  laptop.announceChange();
  await settle();
  expect(phone.codebases.codebases().map((entry) => entry.id)).toEqual(["shop"]);
  stop();
});

it("sends a change by the person to each connected host, and a delete as a tombstone", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.disk.set("/code/shop", { state: "plain" });
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();

  const made = await phone.codebases.create(" Shop ", [{ hostId: "laptop", path: "/code/shop" }]);
  expect(made).toMatchObject({ name: "Shop", updatedAt: 1_000, deletedAt: null });
  expect(made.roots).toEqual([{ installationId: "laptop", path: "/code/shop", name: "shop" }]);
  expect(server.copies.get(made.id)).toEqual(made);

  // The clock of this phone is behind the copy: the change is still the newer one.
  phone.now = 500;
  const renamed = await phone.codebases.rename(made.id, "Shop web");
  expect(renamed.updatedAt).toBe(1_001);
  expect(laptop.copies.get(made.id)?.name).toBe("Shop web");

  await phone.codebases.delete(made.id);
  expect(phone.codebases.codebases()).toEqual([]);
  for (const host of [laptop, server]) {
    expect(host.copies.get(made.id)).toMatchObject({ deletedAt: 1_002, updatedAt: 1_002 });
  }
  stop();
});

it("stores the path that the scan resolved, and refuses a duplicate, a missing folder, and a full codebase", async () => {
  const laptop = new FakeHost("laptop", "installation-laptop");
  laptop.disk.set("/Users/ada/shop", { state: "plain" });
  laptop.disk.set("/Users/ada/libs", { state: "git" });
  laptop.resolved.set("~/shop", "/Users/ada/shop");
  laptop.resolved.set("~/libs", "/Users/ada/libs");
  const phone = new FakePhone(laptop);
  const stop = phone.codebases.watch();
  await settle();

  const made = await phone.codebases.create("Shop", [{ hostId: "laptop", path: "~/shop" }]);
  // The root names the host by its installation id, never by the id of this phone.
  expect(made.roots).toEqual([
    { installationId: "installation-laptop", path: "/Users/ada/shop", name: "shop" },
  ]);
  const added = await phone.codebases.addRoot(made.id, { hostId: "laptop", path: "~/libs" });
  expect(added.roots.map((root) => root.path)).toEqual(["/Users/ada/shop", "/Users/ada/libs"]);

  // A different spelling of a root is the same root.
  const duplicate = phone.codebases.addRoot(made.id, { hostId: "laptop", path: "~/shop" });
  await expect(duplicate).rejects.toMatchObject({ refusal: "duplicate" });
  const missing = phone.codebases.addRoot(made.id, { hostId: "laptop", path: "/gone" });
  await expect(missing).rejects.toBeInstanceOf(CodebaseRootRefused);
  await expect(missing).rejects.toMatchObject({ refusal: "missing" });

  const full = codebase(
    "full",
    2_000,
    Array.from({ length: CODEBASE_ROOTS_MAX }, (_, index) => ({
      installationId: "installation-laptop",
      path: `/code/${index}`,
      name: String(index),
    })),
  );
  laptop.copies.set("full", full);
  await phone.codebases.load("laptop");
  const overLimit = phone.codebases.addRoot("full", { hostId: "laptop", path: "~/libs" });
  await expect(overLimit).rejects.toMatchObject({ refusal: "limit" });
  expect(laptop.copies.get("full")?.roots).toHaveLength(CODEBASE_ROOTS_MAX);

  const removed = await phone.codebases.removeRoot(made.id, {
    installationId: "installation-laptop",
    path: "/Users/ada/libs/",
  });
  expect(removed.roots.map((root) => root.path)).toEqual(["/Users/ada/shop"]);
  stop();
});

it("groups the members by host, keeps the last answer of a host that is away, and keeps a root on an unknown host", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  laptop.disk.set("/code/shop", { state: "plain", found: ["/code/shop/api", "/code/shop/web"] });
  server.disk.set("/srv/infra", { state: "git" });
  const roots = [
    { installationId: "laptop", path: "/code/shop", name: "shop" },
    { installationId: "server", path: "/srv/infra", name: "infra" },
    { installationId: "desktop-at-work", path: "/work/tools", name: "tools" },
  ];
  laptop.copies.set("shop", codebase("shop", 10, roots));
  const phone = new FakePhone(laptop, server);
  const stopHosts = phone.codebases.watch();
  await settle();
  const stopMembers = phone.codebases.watchMembers("shop");
  await settle();

  const [onLaptop, onServer, onUnknown] = phone.codebases.membersOf("shop");
  expect(onLaptop).toMatchObject({ hostId: "laptop", presence: "ready", state: "ready", isStale: false });
  expect(onLaptop?.roots[0]?.member?.state).toBe("plain");
  expect(onLaptop?.roots[0]?.found.map((found) => found.path)).toEqual(["/code/shop/api", "/code/shop/web"]);
  // The server had no copy: it got the copy before it read its members.
  expect(onServer?.roots[0]?.member?.state).toBe("git");
  expect(onUnknown).toMatchObject({ hostId: null, label: null, presence: "unknown", state: "idle" });
  expect(onUnknown?.roots.map((entry) => entry.root.path)).toEqual(["/work/tools"]);

  server.isReady = false;
  await phone.changed();
  const away = phone.codebases.membersOf("shop")[1];
  expect(away).toMatchObject({ presence: "away", isStale: true });
  expect(away?.roots[0]?.member?.state).toBe("git");

  // The host comes back on a new server session: its members are read again.
  server.disk.delete("/srv/infra");
  server.isReady = true;
  server.generation += 1;
  await phone.changed();
  const back = phone.codebases.membersOf("shop")[1];
  expect(back).toMatchObject({ presence: "ready", isStale: false });
  expect(back?.roots[0]?.member?.state).toBe("missing");
  stopMembers();
  stopHosts();
});

it("answers the codebases that hold a project folder on a host", async () => {
  const laptop = new FakeHost("laptop", "installation-laptop");
  const server = new FakeHost("server", "installation-server");
  const onLaptop = { installationId: "installation-laptop", path: "/code/shop", name: "shop" };
  laptop.copies.set("shop", codebase("shop", 10, [onLaptop]));
  laptop.copies.set("gone", codebase("gone", 10, [onLaptop], 10));
  const phone = new FakePhone(laptop, server);
  const stop = phone.codebases.watch();
  await settle();

  const holding = (hostId: string, path: string) =>
    phone.codebases.codebasesOfFolder(hostId, path).map((entry) => entry.id);
  expect(holding("laptop", "/code/shop")).toEqual(["shop"]);
  expect(holding("laptop", "/code/shop/web")).toEqual(["shop"]);
  expect(holding("laptop", "/code/shop-old")).toEqual([]);
  // The same path on a different host is a different folder.
  expect(holding("server", "/code/shop")).toEqual([]);
  stop();
});

it("forgets every copy when the account or the organization changes, and drops an answer of the earlier one", async () => {
  const laptop = new FakeHost("laptop");
  laptop.copies.set("personal", codebase("personal", 10));
  const phone = new FakePhone(laptop);
  const stop = phone.codebases.watch();
  await settle();
  expect(phone.codebases.codebases().map((entry) => entry.id)).toEqual(["personal"]);

  // The read of the earlier scope is still on its way when the organization changes.
  const earlierRead = phone.codebases.load("laptop");
  phone.scope = "account other-organization";
  laptop.copies.clear();
  laptop.copies.set("team", codebase("team", 5));
  await phone.changed();
  await earlierRead;
  await settle();

  expect(phone.codebases.codebases().map((entry) => entry.id)).toEqual(["team"]);
  // The codebase of the earlier organization is not sent to the host under the new one.
  expect(laptop.saves).toEqual([]);
  stop();
});

it("drops what a removed host gave, and tells its listeners about each change", async () => {
  const laptop = new FakeHost("laptop");
  const server = new FakeHost("server");
  server.disk.set("/srv/infra", { state: "git" });
  laptop.copies.set(
    "shop",
    codebase("shop", 10, [{ installationId: "server", path: "/srv/infra", name: "infra" }]),
  );
  const phone = new FakePhone(laptop, server);
  const stopHosts = phone.codebases.watch();
  const stopMembers = phone.codebases.watchMembers("shop");
  await settle();
  const before = phone.codebases.revision;
  const live = phone.codebases.codebases();
  // No change: the same list, so a screen does not draw again.
  expect(phone.codebases.codebases()).toBe(live);

  phone.hosts = [laptop];
  await phone.changed();
  expect(phone.codebases.revision).toBeGreaterThan(before);
  expect(phone.codebases.membersOf("shop")[0]).toMatchObject({ presence: "unknown", state: "idle" });
  stopMembers();
  stopHosts();
});

it("answers the codebase that the host makes for the folder of a draft, and none after a person deleted it", async () => {
  // WHY: the host makes a codebase for a folder that holds repositories (decision 13). The draft shows
  // the repositories of that codebase before Send, and it must not promise one that the host does not make.
  const laptop = new FakeHost("laptop");
  laptop.disk.set("/code/store", { state: "plain", found: ["/code/store/api", "/code/store/web"] });
  laptop.disk.set("/code/notes", { state: "plain" });
  const phone = new FakePhone(laptop);
  const stop = phone.codebases.watch();
  await settle();

  // Before the folder is read, the phone knows nothing about it.
  expect(phone.codebases.newCodebaseAt("laptop", "/code/store")).toBeNull();
  await phone.codebases.readFolder("laptop", "/code/store");
  await phone.codebases.readFolder("laptop", "/code/notes");
  expect(
    phone.codebases.newCodebaseAt("laptop", "/code/store")?.members.map((member) => member.path),
  ).toEqual(["/code/store/api", "/code/store/web"]);
  // A folder with no repository inside it is one folder: the host makes nothing.
  expect(phone.codebases.newCodebaseAt("laptop", "/code/notes")).toBeNull();

  // A codebase holds the folder: the draft gets that codebase, not a new one.
  const made = await phone.codebases.create("store", [{ hostId: "laptop", path: "/code/store" }]);
  expect(phone.codebases.newCodebaseAt("laptop", "/code/store")).toBeNull();
  // The person deleted it: the host keeps that "no", and so does the draft.
  await phone.codebases.delete(made.id);
  expect(phone.codebases.codebasesOfFolder("laptop", "/code/store")).toEqual([]);
  expect(phone.codebases.newCodebaseAt("laptop", "/code/store")).toBeNull();
  stop();
});

it("forgets what a folder holds when the account changes", async () => {
  const laptop = new FakeHost("laptop");
  laptop.disk.set("/code/store", { state: "plain", found: ["/code/store/api"] });
  const phone = new FakePhone(laptop);
  const stop = phone.codebases.watch();
  await settle();
  await phone.codebases.readFolder("laptop", "/code/store");
  expect(phone.codebases.newCodebaseAt("laptop", "/code/store")).not.toBeNull();

  phone.scope = "other-account organization";
  await phone.changed();
  await settle();
  expect(phone.codebases.newCodebaseAt("laptop", "/code/store")).toBeNull();
  stop();
});
