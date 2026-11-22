import { expect, it, vi } from "vite-plus/test";
import type { DiscoveredServer } from "@solus/contracts/types";
import type { SolusApp } from "@solus-mobile/app/solus-app";
import { memoryKeyValueStore } from "@solus-mobile/platform/ports";
import { NearbyDiscovery } from "./discovery";

function fixture(source: DiscoveredServer["source"] = "lan") {
  const host: DiscoveredServer = {
    host: "192.0.2.5",
    port: 3000,
    name: "Nearby",
    installationId: "one",
    source,
  };
  const preview = {
    host: host.host,
    url: "http://192.0.2.5:3000",
    name: host.name,
    installationId: host.installationId,
    trusted: true,
  };
  const app = {
    canScanNearby: true,
    scanNearby: vi.fn(async () => [host]),
    preview: vi.fn<SolusApp["preview"]>().mockResolvedValue({ kind: "found", preview }),
    pair: vi.fn<SolusApp["pair"]>(),
  };
  const discovery = new NearbyDiscovery(app, memoryKeyValueStore());
  return { app, discovery, host, preview };
}
it("pairs a trusted host without a code and retains its tailnet route", async () => {
  const { app, discovery, preview } = fixture("tailnet");
  await Promise.all([discovery.scan(), discovery.scan()]);
  expect(app.pair).toHaveBeenCalledExactlyOnceWith({ ...preview, onTailnet: true }, undefined);
  expect(discovery.snapshot().hosts).toEqual([]);
});
it.each(["protected", "identity changed", "forgotten", "pair refused"])(
  "leaves a %s host for manual pairing",
  async (reason) => {
    const { app, discovery, host, preview } = fixture();
    if (reason === "forgotten") discovery.skipAutomaticPairing(host.installationId);
    if (reason === "pair refused") app.pair.mockRejectedValue(new Error("Code required"));
    if (reason === "protected")
      app.preview.mockResolvedValue({ kind: "found", preview: { ...preview, trusted: false } });
    if (reason === "identity changed")
      app.preview.mockResolvedValue({
        kind: "found",
        preview: { ...preview, installationId: "other" },
      });
    await discovery.scan();
    expect(app.pair).toHaveBeenCalledTimes(reason === "pair refused" ? 1 : 0);
    expect(discovery.snapshot()).toMatchObject({ scanning: false, hosts: [host] });
  },
);
