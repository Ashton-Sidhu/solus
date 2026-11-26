import { expect, it } from "vite-plus/test";
import { sessionCloudReadText } from "@solus/client-core/session-cloud-read-text";
import type { ListMySessionsResponse } from "@solus/contracts/session-repositories";
import type { SessionRecord } from "@solus/contracts/types";
import { solusApiId } from "@solus/contracts/uplink";
import type { HostConnection } from "../hosts/host-connections";
import { CloudHistory, keptOnHostText } from "./cloud-history";
import { CloudSessions } from "./cloud-sessions";

type CloudEntry = ListMySessionsResponse["items"][number];

/** One of the person's own cloud entries (`listMySessions`). */
const ownEntry = (sessionId: string) => ({
  sessionId, title: sessionId, provider: "claude-code", model: null, repositoryKey: null, branch: null,
  lastActivityAt: 1, head: "head", syncedTurn: 1, lastRunHostId: null, runningHostId: null,
}) as unknown as CloudEntry;

/** A record of the organization's session list. */
const organizationRecord = (sessionId: string, publication: SessionRecord["publication"] = "published") => ({
  sessionId, organizationId: "globex", publication, provider: "claude-code", title: sessionId, lastActivityAt: 1,
}) as unknown as SessionRecord;

/** The Solus API of one organization, and each request that this phone made to it. */
function solusApi(organizationId: string, lists: { own: CloudEntry[]; organization: SessionRecord[] }) {
  const requests: string[] = [];
  const connection = {
    hostId: solusApiId(organizationId),
    state: { readiness: "ready" },
    events: { subscribe: () => () => {} },
    onAccepted: () => () => {},
    api: {
      sessionCloudList: async () => { requests.push("own"); return lists.own; },
      sessionRecordList: async () => { requests.push("organization"); return { records: lists.organization }; },
      loadSessionPage: async () => {
        requests.push("page");
        return { before: null, messages: [{ role: "user", content: "Hello", timestamp: 1, messageId: "m1" }] };
      },
    },
  } as unknown as HostConnection;
  return { connection, requests };
}

/** The cloud session list of a phone, with the directory's answer for each organization in `saves`. */
function cloudSessions(saves: Record<string, boolean>) {
  return new CloudSessions({
    savedHostFor: () => null,
    isReady: () => false,
    hostIds: () => ["laptop"],
    savesSessionsToCloud: (organizationId) => saves[organizationId] !== false,
  });
}

it("keeps the published sessions of an organization that saves its sessions to Solus Cloud", async () => {
  // WHY: this is the default. The session list of the organization is a source, and the
  // change for the other case must not remove its rows.
  const api = solusApi("globex", { own: [ownEntry("mine")], organization: [organizationRecord("shared"), organizationRecord("draft", "local")] });
  const cloud = cloudSessions({});
  cloud.follow(api.connection);
  await cloud.load();

  expect(api.requests.sort()).toEqual(["organization", "own"]);
  expect(cloud.recordFor("mine")).toBeDefined();
  expect(cloud.recordFor("shared")).toMatchObject({ publication: "published" });
  expect(cloud.recordFor("draft")).toBeUndefined();
  expect(cloud.onlyInCloud(() => false).map((session) => session.record.sessionId).sort()).toEqual(["mine", "shared"]);
  expect(cloud.isKeptOnHost("unknown")).toBe(false);
});

it("keeps no published session of an organization that does not save its sessions to Solus Cloud", async () => {
  // WHY: the conversations of these sessions are only on their machines. A row from the
  // Solus API would open a session that has no copy to read. The machines list them.
  const api = solusApi("globex", { own: [ownEntry("mine")], organization: [organizationRecord("shared")] });
  const cloud = cloudSessions({ globex: false });
  cloud.follow(api.connection);
  await cloud.load();

  // The Solus API is not a source of these sessions: its session list is not asked.
  expect(api.requests).toEqual(["own"]);
  expect(cloud.recordFor("shared")).toBeUndefined();
  // The person's own cloud entries are a different list. They stay.
  expect(cloud.recordFor("mine")).toBeDefined();
  expect(cloud.onlyInCloud(() => false).map((session) => session.record.sessionId)).toEqual(["mine"]);
});

it("drops a published session read before when the organization stops saving its sessions", async () => {
  // WHY: an administrator can change the policy while the phone shows the list. A row that an
  // earlier read gave must not stay until the next reconnect.
  const saves: Record<string, boolean> = {};
  const api = solusApi("globex", { own: [ownEntry("mine")], organization: [organizationRecord("shared")] });
  const cloud = cloudSessions(saves);
  cloud.follow(api.connection);
  await cloud.load();
  expect(cloud.recordFor("shared")).toBeDefined();

  let notices = 0;
  cloud.changes.subscribe(() => { notices += 1; });
  saves.globex = false;
  cloud.followSessionSource();
  // The row goes when the directory's answer arrives, before a list is read again.
  expect(cloud.recordFor("shared")).toBeUndefined();
  expect(cloud.recordFor("mine")).toBeDefined();
  expect(notices).toBeGreaterThan(0);
  await cloud.load();
  expect(cloud.recordFor("shared")).toBeUndefined();

  // The policy changes back: the session list of the organization is a source again.
  saves.globex = true;
  cloud.followSessionSource();
  await cloud.load();
  expect(cloud.recordFor("shared")).toMatchObject({ publication: "published" });
});

it("does not keep a list answer that was asked before the organization stopped saving its sessions", async () => {
  // WHY: the answer of the organization's list can arrive after the directory's new answer.
  // If the phone kept it, the published rows would come back.
  const saves: Record<string, boolean> = {};
  const api = solusApi("globex", { own: [], organization: [organizationRecord("shared")] });
  const cloud = cloudSessions(saves);
  cloud.follow(api.connection);
  const asked = cloud.load();
  saves.globex = false;
  cloud.followSessionSource();
  await asked;
  // Before a later read can remove it: the old answer itself must write no row.
  expect(cloud.recordFor("shared")).toBeUndefined();
  await cloud.load();
  expect(cloud.recordFor("shared")).toBeUndefined();
});

it("does not read the cloud copy of a session that its organization keeps on its host", async () => {
  // WHY: Solus Cloud has no conversation of this session. A request for it is a request for
  // nothing, and the reader must see why the session does not show, not an error.
  const api = solusApi("globex", { own: [ownEntry("mine")], organization: [organizationRecord("shared")] });
  const cloud = cloudSessions({ globex: false });
  cloud.follow(api.connection);
  await cloud.load();
  const history = new CloudHistory(cloud);
  api.requests.length = 0;

  expect(cloud.isKeptOnHost("shared")).toBe(true);
  const copy = await history.read("shared", "claude-code");
  expect(api.requests).toEqual([]);
  expect(copy.order).toEqual([]);
  // The words are the words of desktop and web for a session with no copy.
  const shared = sessionCloudReadText({ kind: "sync-off" }, "");
  expect(keptOnHostText()).toBe("Solus Cloud has no copy of this session. It is stored only on the machine that ran it.");
  expect(keptOnHostText()).toBe(`${shared.message} ${shared.detail}`);

  // One of the person's own cloud entries has a copy. It is read as before.
  expect(cloud.isKeptOnHost("mine")).toBe(false);
  const own = await history.read("mine", "claude-code");
  expect(api.requests).toEqual(["page"]);
  expect(own.order).toEqual(["m1"]);
});

it("reads the cloud copy of a session when the organization saves its sessions", async () => {
  // WHY: the default case must still read the copy while the host is away.
  const api = solusApi("globex", { own: [], organization: [organizationRecord("shared")] });
  const cloud = cloudSessions({});
  cloud.follow(api.connection);
  await cloud.load();
  const history = new CloudHistory(cloud);
  api.requests.length = 0;

  expect(cloud.isKeptOnHost("shared")).toBe(false);
  const copy = await history.read("shared", "claude-code");
  expect(api.requests).toEqual(["page"]);
  expect(copy.order).toEqual(["m1"]);
});
