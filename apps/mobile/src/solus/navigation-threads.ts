import {
  EMPTY_STEADY_SHELLS_STATE,
  stepSteadyShells,
  type SteadyShellInput,
  type SteadyShellsState,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { sameItems } from "@solus/client-core/keep-equal";
import type { SessionListThread } from "./session-list";

type Rows = readonly SessionListThread[];
const empty: Rows = [];

/** Adapt Solus directory reads to T3's reconnect and release rules. */
export function createNavigationThreads() {
  let state: SteadyShellsState<Rows> = EMPTY_STEADY_SHELLS_STATE;
  let previous = new Map<EnvironmentId, SteadyShellInput<Rows>>();
  let scope: string | undefined;
  return (
    rows: Rows,
    hosts: readonly { environmentId: EnvironmentId; connectionState: string }[],
    phase: (id: EnvironmentId) => "idle" | "loaded" | "loading" | "error",
    account: string,
    now: number,
    actions?: ReadonlyMap<string, number>,
  ) => {
    if (scope !== account) {
      state = EMPTY_STEADY_SHELLS_STATE;
      previous.clear();
      scope = account;
    }
    const groups = new Map<EnvironmentId, SessionListThread[]>();
    const onlyHost =
      hosts.length === 1 && rows.every((row) => row.environmentId === hosts[0]!.environmentId);
    if (!onlyHost) {
      for (const row of rows) {
        const group = groups.get(row.environmentId);
        if (group) group.push(row);
        else groups.set(row.environmentId, [row]);
      }
    }
    const inputs = new Map<EnvironmentId, SteadyShellInput<Rows>>();
    const add = (id: EnvironmentId, source: Rows, connecting: boolean) => {
      const prior = previous.get(id);
      const status = phase(id);
      const settled = status === "loaded";
      const snapshot =
        source.length || settled
          ? prior?.snapshot && sameItems(prior.snapshot, source)
            ? prior.snapshot
            : source
          : null;
      const generation =
        (prior?.generation ?? 0) +
        Number(settled && (prior?.status !== "live" || prior.snapshot !== snapshot));
      inputs.set(id, {
        environmentId: id,
        snapshot,
        generation,
        serverSequence: generation,
        status: settled ? "live" : connecting ? "synchronizing" : "cached",
        connecting,
        rowActions: actions?.get(id) ?? 0,
      });
    };
    for (const host of hosts) {
      add(
        host.environmentId,
        onlyHost ? rows : (groups.get(host.environmentId) ?? empty),
        host.connectionState !== "offline",
      );
    }
    for (const [id, group] of groups) if (!inputs.has(id)) add(id, group, false);
    previous = inputs;
    state = stepSteadyShells(state, [...inputs.values()], now);
    let holding = false;
    const shown = new Map<EnvironmentId, Map<string, SessionListThread>>();
    for (const [id, shell] of state.shells) {
      if (shell.shown !== inputs.get(id)?.snapshot) {
        holding = true;
        shown.set(id, new Map(shell.shown?.map((row) => [row.id, row])));
      }
    }
    // A removed row can be a revoked share. Only show rows the current scope can still read.
    const threads = holding
      ? rows.flatMap((row) => {
          const held = shown.get(row.environmentId);
          return held ? (held.get(row.id) ?? []) : row;
        })
      : rows;
    return { threads, holding, releaseAt: state.releaseAt };
  };
}
