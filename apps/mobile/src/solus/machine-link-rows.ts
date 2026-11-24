import {
  linkMachines,
  linkedOnlyMachines,
  machineLinkChoices,
  machineLinkViews,
  pairedHostRoute,
  worseLinkState,
  type LinkMachine,
  type MachineLinkOutcome,
  type MachineLinkState,
} from "@solus/client-core/host-linking";
import type { HostLinkHealth, HostPairing } from "@solus/contracts/host-pairing";
import type { HostRoute } from "@solus/contracts/host-routes";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_COUNTDOWN_DAYS = 7;

export interface MachineLinkDirection {
  readonly pairing: HostPairing;
  readonly health: HostLinkHealth | undefined;
  readonly state: MachineLinkState;
}

/** One link of a machine, from that machine's side. A two-way link has `back`. */
export interface MachineLinkRow extends MachineLinkDirection {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly back: MachineLinkDirection | null;
  /** The state that wants more attention, of the two directions of a two-way link. */
  readonly shownState: MachineLinkState;
  readonly canLinkBack: boolean;
  /** This phone has no environment for the target: it knows it only through the link. */
  readonly isLinkedOnly: boolean;
}

/**
 * The links that `sourceId` holds, in its own order, with the health and the
 * two-way rule of `machineLinkViews` (desktop and web use the same views). A
 * two-way link that the views list from the other machine is turned around.
 */
export function machineLinkRows(
  machines: readonly LinkMachine[],
  health: ReadonlyMap<string, readonly HostLinkHealth[] | "unavailable">,
  sourceId: string,
  knownIds: ReadonlySet<string>,
  now: number,
): MachineLinkRow[] {
  const views = machineLinkViews(machines, health, now);
  const linkedOnly = new Set(linkedOnlyMachines(views, knownIds).map(({ installationId }) => installationId));
  const rows: MachineLinkRow[] = [];
  for (const view of views) {
    if (view.sourceId === sourceId) {
      rows.push({
        targetId: view.targetId, targetLabel: view.targetLabel,
        pairing: view.pairing, health: view.health, state: view.state, back: view.back,
        shownState: view.back ? worseLinkState(view.state, view.back.state) : view.state,
        canLinkBack: view.canLinkBack, isLinkedOnly: linkedOnly.has(view.targetId),
      });
    } else if (view.targetId === sourceId && view.back) {
      rows.push({
        targetId: view.sourceId, targetLabel: view.sourceLabel,
        ...view.back,
        back: { pairing: view.pairing, health: view.health, state: view.state },
        shownState: worseLinkState(view.back.state, view.state),
        canLinkBack: false, isLinkedOnly: false,
      });
    }
  }
  const order = machines.find(({ info }) => info.installationId === sourceId)?.snapshot?.hosts
    .map(({ listing }) => listing.installationId) ?? [];
  return rows.sort((left, right) => order.indexOf(left.targetId) - order.indexOf(right.targetId));
}

/** The machines whose link health the rows of `sourceId` read: it, and each machine that links back to it. */
export function linkHealthSources(machines: readonly LinkMachine[], sourceId: string): string[] {
  const source = machines.find(({ info }) => info.installationId === sourceId);
  if (!source?.snapshot) return [];
  const targets = new Set(source.snapshot.hosts.map(({ listing }) => listing.installationId));
  return [sourceId, ...machines
    .filter(({ info, snapshot }) => targets.has(info.installationId)
      && snapshot?.hosts.some(({ listing }) => listing.installationId === sourceId))
    .map(({ info }) => info.installationId)];
}

/** Every address of the link, the one it pairs on first. */
export function linkAddresses(pairing: HostPairing): HostRoute[] {
  const first = pairedHostRoute(pairing);
  const rest = pairing.listing.routes.filter(({ url }) => url !== first?.url);
  return first ? [first, ...rest] : rest;
}

/** "Expires in 3 days" near the end; else the date. Null for a link that has no end now. */
export function linkExpiryText(health: HostLinkHealth, now: number): string | null {
  if (health.expiresAt === null) return null;
  const days = Math.ceil((health.expiresAt - now) / DAY_MS);
  if (days <= 1) return "Expires within a day";
  if (days <= EXPIRY_COUNTDOWN_DAYS) return `Expires in ${days} days`;
  return `Expires ${new Date(health.expiresAt).toLocaleDateString()}`;
}

export function linkedDateText(pairing: HostPairing): string {
  return `Linked ${new Date(pairing.pairedAt).toLocaleDateString()}`;
}

/** Links the target of a one-way link to its source, with the flow of Link machines. */
export async function linkBack(machines: readonly LinkMachine[], sourceId: string, targetId: string): Promise<MachineLinkOutcome> {
  const target = machines.find(({ info }) => info.installationId === targetId);
  const choice = target ? machineLinkChoices(target, machines).find(({ id }) => id === sourceId) : undefined;
  if (!target || !choice) return "failed";
  let outcome: MachineLinkOutcome = "failed";
  await linkMachines(target, [choice], (_id, result) => { outcome = result; });
  return outcome;
}
