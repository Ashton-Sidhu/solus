import { expect, it, vi } from "vite-plus/test";
import type { PersonHistoryEntry } from "@solus/contracts/person-history";
import { solusApiId } from "@solus/contracts/uplink";
import { Listeners } from "@solus-mobile/lib/listeners";
import {
  MobilePersonHistory,
  type PersonHistoryConnection,
} from "@solus-mobile/features/history/person-history";

/** A host or Solus API that keeps the history it was sent, as a home does. */
function home(entries: PersonHistoryEntry[] = []) {
  const kept = new Map(entries.map((entry) => [entry.key, entry.openedAt]));
  const state = { readiness: "ready" as "ready" | "unreachable" };
  const list = vi.fn(async () =>
    [...kept].map(([key, openedAt]) => ({ key, openedAt })).sort((a, b) => b.openedAt - a.openedAt),
  );
  const record = vi.fn(async (sent: PersonHistoryEntry[]) => {
    for (const entry of sent) kept.set(entry.key, Math.max(entry.openedAt, kept.get(entry.key) ?? 0));
  });
  const connection = {
    api: { personHistoryList: list, personHistoryRecord: record },
    events: { subscribe: () => () => {} },
    state,
  } as unknown as PersonHistoryConnection;
  return { connection, state, list, record, kept };
}

function phone(connections: { [serverId: string]: PersonHistoryConnection }) {
  const account = { signedIn: false, solusApiId: null as string | null };
  const changes = new Listeners();
  const history = new MobilePersonHistory({
    account: () => account,
    defaultHostId: () => "laptop",
    connection: (serverId) => connections[serverId] ?? null,
    onChange: changes.subscribe,
    batchDelayMs: 0,
  });
  return { history, account, changes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

it("keeps the history on the default host signed out, and in the Solus API signed in", async () => {
  const laptop = home([{ key: "work:plan", openedAt: 100 }]);
  const api = home([{ key: "work:deck", openedAt: 50 }]);
  const apiId = solusApiId("org");
  const connections: { [serverId: string]: PersonHistoryConnection } = { laptop: laptop.connection };
  const { history, account, changes } = phone(connections);
  await settle();
  expect(history.homeServerId).toBe("laptop");
  expect(history.openedAt("work:plan")).toBe(100);

  // Signed in, but the directory lists no Solus API route yet: the history stays on the host.
  account.signedIn = true;
  changes.notify();
  expect(history.homeServerId).toBe("laptop");

  // The account's Solus API is not connected yet: the host's history still shows.
  account.solusApiId = apiId;
  changes.notify();
  await settle();
  expect(history.homeServerId).toBe("laptop");
  expect(history.openedAt("work:plan")).toBe(100);

  connections[apiId] = api.connection;
  changes.notify();
  await settle();
  expect(history.homeServerId).toBe(apiId);
  // The laptop's history went into the account, and the account's own stays.
  expect(api.record).toHaveBeenCalledWith([{ key: "work:plan", openedAt: 100 }]);
  expect(history.entries()).toEqual([
    { key: "work:plan", openedAt: 100 },
    { key: "work:deck", openedAt: 50 },
  ]);

  // Signed out, the account's history goes at once, even before the host answers.
  delete connections.laptop;
  account.signedIn = false;
  account.solusApiId = null;
  changes.notify();
  await settle();
  expect(history.homeServerId).toBeNull();
  expect(history.entries()).toEqual([]);

  // The phone reads the default host again; nothing is moved back.
  connections.laptop = laptop.connection;
  changes.notify();
  await settle();
  expect(history.homeServerId).toBe("laptop");
  expect(history.openedAt("work:deck")).toBeNull();
  history.dispose();
});

it("sends an open to the home and reads the home again when it is ready again", async () => {
  const laptop = home();
  const { history, changes } = phone({ laptop: laptop.connection });
  await settle();
  history.record("work:plan");
  await settle();
  expect([...laptop.kept.keys()]).toEqual(["work:plan"]);

  const reads = laptop.list.mock.calls.length;
  laptop.state.readiness = "unreachable";
  changes.notify();
  await settle();
  expect(laptop.list).toHaveBeenCalledTimes(reads);
  // Another device opened a work while this phone was away.
  laptop.kept.set("work:deck", Date.now() + 1_000);
  laptop.state.readiness = "ready";
  changes.notify();
  await settle();
  expect(laptop.list).toHaveBeenCalledTimes(reads + 1);
  expect(history.entries()[0]?.key).toBe("work:deck");
  history.dispose();
});

it("waits for the home's connection before it reads", async () => {
  const laptop = home([{ key: "work:plan", openedAt: 100 }]);
  const connections: { [serverId: string]: PersonHistoryConnection } = {};
  const { history, changes } = phone(connections);
  expect(history.homeServerId).toBeNull();
  connections.laptop = laptop.connection;
  changes.notify();
  await settle();
  expect(history.homeServerId).toBe("laptop");
  expect(history.openedAt("work:plan")).toBe(100);
  history.dispose();
});
