import type { DiscoveredServer } from "@solus/contracts/types";
import { Listeners } from "@solus-mobile/lib/listeners";

export type AddOutcome =
  | { state: "waiting" }
  | { state: "added" }
  | { state: "failed"; message: string };

export interface AddSeveralState {
  /** The installation ids of the found hosts that Add sends a request to. */
  selected: ReadonlySet<string>;
  outcomes: ReadonlyMap<string, AddOutcome>;
  /** The check code each selected host shows while its request waits. */
  checkCode: string | null;
  isRunning: boolean;
}

/** Sends one approval request to a host with the shared check code; throws why it failed. */
export type PairByApproval = (
  host: DiscoveredServer,
  checkCode: string,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Adds several nearby hosts at once, as desktop's
 * `AddSeveral` does: one approval request to each, all with the same check code,
 * so the person approves each one on its own machine. Each request ends on its
 * own. An added host leaves the selection; a host that fails stays selected with
 * its error, so Add tries it again. The state of one Nearby hosts list.
 */
export class AddSeveral {
  readonly changes = new Listeners();
  private state: AddSeveralState = {
    selected: new Set(),
    outcomes: new Map(),
    checkCode: null,
    isRunning: false,
  };
  private controller: AbortController | null = null;

  constructor(private readonly makeCheckCode: () => string) {}

  snapshot = (): AddSeveralState => this.state;

  toggle(installationId: string): void {
    const selected = new Set(this.state.selected);
    if (!selected.delete(installationId)) selected.add(installationId);
    this.set({ selected });
  }

  /** Selects every host that is not added yet, or none when all of them are selected. */
  toggleAll(hosts: readonly DiscoveredServer[]): void {
    const open = hosts.filter(
      (host) => this.state.outcomes.get(host.installationId)?.state !== "added",
    );
    const isAll = open.length > 0 && open.every((host) => this.state.selected.has(host.installationId));
    const selected = new Set(this.state.selected);
    for (const host of open) {
      if (isAll) selected.delete(host.installationId);
      else selected.add(host.installationId);
    }
    this.set({ selected });
  }

  async add(hosts: readonly DiscoveredServer[], pair: PairByApproval): Promise<void> {
    const chosen = hosts.filter((host) => this.state.selected.has(host.installationId));
    if (this.state.isRunning || !chosen.length) return;
    const controller = new AbortController();
    this.controller = controller;
    // The code shows before the requests go, so the person can compare it on each machine.
    const checkCode = this.makeCheckCode();
    const outcomes = new Map(this.state.outcomes);
    for (const host of chosen) outcomes.set(host.installationId, { state: "waiting" });
    this.set({ checkCode, isRunning: true, outcomes });
    try {
      await Promise.all(
        chosen.map(async (host) => {
          const { installationId } = host;
          try {
            await pair(host, checkCode, controller.signal);
            const selected = new Set(this.state.selected);
            selected.delete(installationId);
            this.setOutcome(installationId, { state: "added" }, { selected });
          } catch (error) {
            this.setOutcome(
              installationId,
              controller.signal.aborted
                ? null
                : { state: "failed", message: error instanceof Error ? error.message : String(error) },
            );
          }
        }),
      );
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.set({ checkCode: null, isRunning: false });
      }
    }
  }

  /** Stops every request that still waits; leaving the list stops them too. */
  stop(): void {
    this.controller?.abort();
  }

  private setOutcome(
    installationId: string,
    outcome: AddOutcome | null,
    patch: Partial<AddSeveralState> = {},
  ): void {
    const outcomes = new Map(this.state.outcomes);
    if (outcome) outcomes.set(installationId, outcome);
    else outcomes.delete(installationId);
    this.set({ ...patch, outcomes });
  }

  private set(patch: Partial<AddSeveralState>): void {
    this.state = { ...this.state, ...patch };
    this.changes.notify();
  }
}
