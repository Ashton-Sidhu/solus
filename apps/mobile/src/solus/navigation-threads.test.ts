import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { SessionShellProgress } from "@solus-mobile/features/threads/session-shell";
import type { SessionRecord } from "@solus/contracts/types";
import { createNavigationThreads } from "./navigation-threads";
import { createSessionListProjection } from "./session-list";

const a = EnvironmentId.make("host-a");
const b = EnvironmentId.make("host-b");

const project = createSessionListProjection();
const noFacts = { views: new Map(), states: new Map(), pins: new Map() };
/** One list row of a session on a host, as the home list projects it. */
const thread = (environmentId: EnvironmentId, id: string) => {
  // SAFETY: the projection reads only these fields of a record.
  const record = { sessionId: id, provider: "claude-code", projectPath: "/work/app", cwd: "/work/app", title: id, createdAt: 1, lastActivityAt: 1, size: 1 } as SessionRecord;
  return project([{ hostId: environmentId, key: `${environmentId}\u0000${id}`, record }], noFacts)[0]!;
};

it("holds the fresh shell rows of one host while another host connects, then shows them together", () => {
  const navigation = createNavigationThreads();
  const hosts = [
    { environmentId: a, connectionState: "connected" },
    { environmentId: b, connectionState: "connecting" },
  ];
  const progress = new Map<EnvironmentId, SessionShellProgress>([
    [a, { status: "cached", sequence: 5, generation: 0 }],
    [b, { status: "cached", sequence: 3, generation: 0 }],
  ]);
  const shell = (id: EnvironmentId) => progress.get(id) ?? null;
  const phase = () => "loading" as const;
  const saved = [thread(a, "a-saved"), thread(b, "b-saved")];
  // The start shows both saved shells.
  expect(navigation(saved, hosts, phase, "account", 0, undefined, shell).threads).toEqual(saved);

  // Host A is live with a new row; host B still synchronizes its connection.
  progress.set(a, { status: "live", sequence: 6, generation: 1 });
  progress.set(b, { status: "synchronizing", sequence: 3, generation: 0 });
  const fresh = [thread(a, "a-new"), thread(a, "a-saved"), thread(b, "b-saved")];
  const held = navigation(fresh, hosts, phase, "account", 100, undefined, shell);
  expect(held.holding).toBe(true);
  expect(held.threads.map((row) => row.id)).toEqual(["a-saved", "b-saved"]);
  expect(held.releaseAt).toBe(2_100);

  // Host B is live too: both hosts' rows show at once.
  progress.set(b, { status: "live", sequence: 3, generation: 2 });
  const together = navigation(fresh, hosts, phase, "account", 200, undefined, shell);
  expect(together.holding).toBe(false);
  expect(together.threads).toBe(fresh);
});

it("shows the held rows at the latest when the release window ends", () => {
  const navigation = createNavigationThreads();
  const hosts = [
    { environmentId: a, connectionState: "connected" },
    { environmentId: b, connectionState: "connecting" },
  ];
  const progress = new Map<EnvironmentId, SessionShellProgress>([
    [a, { status: "cached", sequence: 5, generation: 0 }],
    [b, { status: "cached", sequence: 3, generation: 0 }],
  ]);
  const shell = (id: EnvironmentId) => progress.get(id) ?? null;
  const phase = () => "loading" as const;
  navigation([thread(a, "a-saved")], hosts, phase, "account", 0, undefined, shell);
  progress.set(a, { status: "live", sequence: 6, generation: 1 });
  progress.set(b, { status: "synchronizing", sequence: 3, generation: 0 });
  const fresh = [thread(a, "a-new"), thread(a, "a-saved")];
  expect(navigation(fresh, hosts, phase, "account", 100, undefined, shell).holding).toBe(true);
  expect(navigation(fresh, hosts, phase, "account", 2_100, undefined, shell).threads).toBe(fresh);
});
