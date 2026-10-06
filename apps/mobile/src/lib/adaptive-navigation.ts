// Adapted from T3 Code apps/mobile/src/lib/adaptive-navigation.ts (MIT, see UPSTREAM.md).
import type { CommonActions, NavigationState } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/routes";

export type AdaptiveNavigationAction = "push" | "replace" | "set-params";

/**
 * Solus reads route names where T3 reads URL paths: T3's "/" is `Home` and its
 * base thread path is `Thread`.
 */
export function isBaseThreadRoute(routeName: string | undefined): boolean {
  return routeName === "Thread";
}

/**
 * A persistent sidebar selects a peer destination in place. A compact list
 * drills into a new destination so the native back stack remains available.
 * From Home the selection pushes (never replaces) so Home stays beneath the
 * thread — collapsing back to a compact width keeps a sane back stack.
 */
export function resolveThreadSelectionNavigationAction(input: {
  readonly usesSplitView: boolean;
  readonly routeName: string | undefined;
}): AdaptiveNavigationAction {
  if (!input.usesSplitView || input.routeName === "Home") {
    return "push";
  }

  return isBaseThreadRoute(input.routeName) ? "set-params" : "replace";
}

/** Dismiss sheets and select their underlying workspace destination in one stack update. */
export function resolveThreadSelectionOverlayState(input: {
  readonly state: NavigationState | undefined;
  readonly workspaceRouteKey: string | undefined;
  readonly action: AdaptiveNavigationAction;
  readonly params: RootStackParamList["Thread"];
}): Parameters<typeof CommonActions.reset>[0] | null {
  if (input.state === undefined) return null;
  const workspaceIndex = input.state.routes.findIndex(
    (route) => route.key === input.workspaceRouteKey,
  );
  if (workspaceIndex < 0 || workspaceIndex >= input.state.index) return null;

  const workspaceRoute = input.state.routes[workspaceIndex];
  const routes = input.state.routes.slice(0, workspaceIndex + (input.action === "push" ? 1 : 0));
  return {
    ...input.state,
    index: routes.length,
    routes: [
      ...routes,
      input.action === "set-params" && workspaceRoute?.name === "Thread"
        ? { ...workspaceRoute, params: { ...workspaceRoute.params, ...input.params } }
        : { name: "Thread", params: input.params },
    ],
  };
}

/**
 * On regular-width layouts, the file browser and preview occupy one workspace
 * destination. Replacing the browser route keeps a single back step to chat.
 * Compact layouts retain the browser as the previous stack screen.
 */
export function resolveFileSelectionNavigationAction(input: {
  readonly hasPersistentFileInspector: boolean;
}): AdaptiveNavigationAction {
  return input.hasPersistentFileInspector ? "replace" : "push";
}
