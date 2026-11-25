import type { DiscoveredServer } from "@solus/contracts/types";
import type { SolusApp } from "@solus-mobile/app/solus-app";
import type { KeyValueStore } from "@solus-mobile/platform/ports";
import { Listeners } from "@solus-mobile/lib/listeners";

type NearbyState = {
  scanning: boolean;
  hosts: readonly DiscoveredServer[];
  error: string | null;
};

export class NearbyDiscovery {
  readonly changes = new Listeners();
  private hostBecameReady = false;
  private state: NearbyState = { scanning: false, hosts: [], error: null };
  snapshot = () => this.state;

  constructor(
    private readonly app: Pick<SolusApp, "canScanNearby" | "scanNearby" | "preview" | "pair">,
    private readonly storage: KeyValueStore,
  ) {}

  skipAutomaticPairing(hostId: string) {
    this.storage.setItem("nearby.skip." + hostId, "1");
  }

  onHostReady() {
    // A connected host can see tailnet peers the device cannot see on Wi-Fi.
    if (this.state.scanning) this.hostBecameReady = true;
    else void this.scan();
  }

  scan = async () => {
    if (this.state.scanning || !this.app.canScanNearby) return;
    this.state = { ...this.state, scanning: true, error: null };
    this.changes.notify();
    try {
      const found = await this.app.scanNearby();
      const remaining: DiscoveredServer[] = [];
      for (const host of found) {
        if (!this.storage.getItem("nearby.skip." + host.installationId)) {
          try {
            const result = await this.app.preview(nearbyUrl(host));
            if (
              result.kind === "found" &&
              result.preview.installationId === host.installationId &&
              result.preview.trusted
            ) {
              await this.app.pair(
                { ...result.preview, onTailnet: host.source === "tailnet" },
                undefined,
              );
              continue;
            }
          } catch {
            // A host may move or revoke network trust between discovery and pairing.
          }
        }
        remaining.push(host);
      }
      this.state = { scanning: false, hosts: remaining, error: null };
    } catch {
      this.state = {
        scanning: false,
        hosts: [],
        error: "Could not scan the network. Check local network access and try again.",
      };
    }
    this.changes.notify();
    if (this.hostBecameReady) {
      this.hostBecameReady = false;
      void this.scan();
    }
  };
}

export function nearbyUrl(host: DiscoveredServer) {
  return `http://${host.host.includes(":") ? "[" + host.host + "]" : host.host}:${host.port}`;
}
