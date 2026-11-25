import { expect, it, vi } from "vite-plus/test";
import type { DiscoveredServer } from "@solus/contracts/types";
import { AddSeveral, type PairByApproval } from "./add-several";

const host = (installationId: string): DiscoveredServer => ({
  host: "192.0.2.5",
  port: 3000,
  name: installationId,
  installationId,
  source: "lan",
});

/** A pairing per host that ends when the test says so, or when its signal aborts. */
function pendingPairs() {
  const ends = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const pair = vi.fn<PairByApproval>(
    (target, _checkCode, signal) =>
      new Promise<void>((resolve, reject) => {
        ends.set(target.installationId, { resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("The approval request was stopped.")));
      }),
  );
  return { pair, ends };
}

it("sends one request to each selected host, all with one check code", async () => {
  const batch = new AddSeveral(() => "ABCD-EFGH");
  const hosts = [host("one"), host("two"), host("three")];
  batch.toggle("one");
  batch.toggle("three");
  const pair = vi.fn<PairByApproval>(async () => undefined);
  await batch.add(hosts, pair);
  expect(pair.mock.calls.map(([target, checkCode]) => [target.installationId, checkCode])).toEqual([
    ["one", "ABCD-EFGH"],
    ["three", "ABCD-EFGH"],
  ]);
});

it("takes an added host out of the selection and keeps a failed one with its message", async () => {
  const batch = new AddSeveral(() => "ABCD-EFGH");
  const { pair, ends } = pendingPairs();
  batch.toggleAll([host("one"), host("two")]);
  const running = batch.add([host("one"), host("two")], pair);
  expect(batch.snapshot().checkCode).toBe("ABCD-EFGH");
  expect(batch.snapshot().outcomes.get("one")).toEqual({ state: "waiting" });
  ends.get("one")!.resolve();
  ends.get("two")!.reject(new Error("The owner of that machine denied the request."));
  await running;
  const state = batch.snapshot();
  expect([...state.selected]).toEqual(["two"]);
  expect(state.outcomes.get("one")).toEqual({ state: "added" });
  expect(state.outcomes.get("two")).toEqual({
    state: "failed",
    message: "The owner of that machine denied the request.",
  });
  expect(state.checkCode).toBeNull();
  expect(state.isRunning).toBe(false);
  // Add tries the failed host again, and only that one.
  pair.mockClear();
  const again = batch.add([host("one"), host("two")], pair);
  expect(pair.mock.calls.map(([target]) => target.installationId)).toEqual(["two"]);
  ends.get("two")!.resolve();
  await again;
});

it("clears the waiting rows when the person stops", async () => {
  const batch = new AddSeveral(() => "ABCD-EFGH");
  const { pair } = pendingPairs();
  batch.toggleAll([host("one"), host("two")]);
  const running = batch.add([host("one"), host("two")], pair);
  batch.stop();
  await running;
  const state = batch.snapshot();
  expect(state.outcomes.size).toBe(0);
  expect([...state.selected].sort()).toEqual(["one", "two"]);
  expect(state.checkCode).toBeNull();
  expect(state.isRunning).toBe(false);
});
