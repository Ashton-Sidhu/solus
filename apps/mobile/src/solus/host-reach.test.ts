import { expect, it, vi } from "vite-plus/test";
import type { IntroducedHostsSummary } from "@solus/contracts/host-api";
import type { HostPairingsSnapshot } from "@solus/contracts/host-pairing";
import { HostReach, type HostReachConnection } from "@solus-mobile/features/hosts/host-reach";
import { Listeners } from "@solus-mobile/lib/listeners";

const NOW = 1_000_000;

const pairings: HostPairingsSnapshot = {
  hosts: [
    {
      listing: { id: "laptop", installationId: "laptop", label: "Laptop", routes: [], lastConnected: 0 },
      pairedAt: 0,
      health: { lastReachedAt: NOW, lastError: null, expiresAt: NOW + 30 * 86_400_000 },
    },
  ],
  forgotten: [],
};

const introduced = (...ids: string[]): IntroducedHostsSummary => ({
  hosts: ids.map((id) => ({ installationId: id, label: id === "laptop" ? "Laptop" : "Server", url: "http://192.0.2.9:3000", identityKey: "key", introducedAt: 0 })),
  refused: [],
});

function fixture() {
  const listChanged = new Set<() => void>();
  const accepted = new Set<() => void>();
  const changes = new Listeners();
  const hostIntroductionsList = vi.fn(async () => introduced("laptop", "server"));
  let snapshot: HostPairingsSnapshot | null = pairings;
  const connection: HostReachConnection & { state: { sessionGeneration: number } } = {
    api: { hostIntroductionsList },
    events: {
      subscribe: (_type, listener) => {
        listChanged.add(listener);
        return () => listChanged.delete(listener);
      },
    },
    pairings: { snapshot: () => snapshot },
    state: { sessionGeneration: 1 },
    onAccepted: (listener) => {
      accepted.add(listener);
      return () => accepted.delete(listener);
    },
  };
  let isOwner = true;
  const reach = new HostReach({
    connectionFor: () => connection,
    isOwner: () => isOwner,
    changes,
    now: () => NOW,
  });
  return {
    reach,
    connection,
    hostIntroductionsList,
    changes,
    setOwner: (value: boolean) => { isOwner = value; },
    dropPairings: () => { snapshot = null; },
    fireListChanged: () => { for (const call of listChanged) call(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("lists each machine once: a pairing before an introduction to the same machine", async () => {
  const { reach } = fixture();
  reach.watch("desk");
  await settle();
  const view = reach.viewOf("desk");
  expect(view.kind === "loaded" && view.machines.map(({ label, way }) => [label, way])).toEqual([
    ["Laptop", "paired"],
    ["Server", "introduced"],
  ]);
});

it("reads the introductions again when the host's list changes", async () => {
  const { reach, hostIntroductionsList, fireListChanged } = fixture();
  reach.watch("desk");
  await settle();
  hostIntroductionsList.mockResolvedValueOnce(introduced("laptop"));
  fireListChanged();
  await settle();
  const view = reach.viewOf("desk");
  expect(view.kind === "loaded" && view.machines.map(({ label }) => label)).toEqual(["Laptop"]);
});

it("does not show a read from an earlier server session", async () => {
  const { reach, connection, hostIntroductionsList, changes, dropPairings } = fixture();
  dropPairings();
  reach.watch("desk");
  await settle();
  hostIntroductionsList.mockImplementationOnce(() => new Promise(() => {}));
  connection.state.sessionGeneration = 2;
  changes.notify();
  expect(reach.viewOf("desk")).toEqual({ kind: "reading" });
});

it("hides the section from a phone that is not the host's local owner", async () => {
  const { reach, hostIntroductionsList, setOwner } = fixture();
  setOwner(false);
  reach.watch("desk");
  await settle();
  expect(reach.viewOf("desk")).toEqual({ kind: "hidden" });
  expect(hostIntroductionsList).not.toHaveBeenCalled();
});
