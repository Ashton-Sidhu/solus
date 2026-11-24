import { routeKindLabel, routeRows, routeState, routeStateText, type RouteHolder, type RouteRow, type RouteState } from "@solus/client-core/host-route-control";
import type { HostReadinessState } from "@solus/client-core/host-readiness";

export interface HostRouteStateRow {
  readonly url: string;
  readonly kindLabel: string;
  readonly isLearned: boolean;
  readonly state: RouteState;
  readonly stateText: string;
}

/**
 * Each route of a host, in the order the phone tries them, with how it is
 * doing now (`routeState`): not only the route in use. The phone dials from no
 * page, so no route is blocked by a page origin.
 */
export function hostRouteStates(holder: RouteHolder, dialedUrl: string | null, readiness: HostReadinessState): HostRouteStateRow[] {
  return routeRows(holder, { clientOrigin: "" }).map((row: RouteRow) => {
    const state = routeState(row, dialedUrl, readiness);
    return { url: row.url, kindLabel: routeKindLabel(row.kind), isLearned: row.isLearned, state, stateText: routeStateText(state, row) };
  });
}
