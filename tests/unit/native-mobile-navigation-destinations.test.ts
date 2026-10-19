// The Android workspace has three destinations: Chats, Pull Requests, and
// Settings. Settings is selected from the root stack, never stored, so Back
// and every other way out keep the selection true. These tests pin that
// choosing a destination keeps history: Settings opens over where the person
// was and closes back to it, and only a different list tab goes to Home.
import * as NodeModule from "node:module";
import { readFileSync } from "node:fs";
import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import { describe, expect, it } from "bun:test";

import {
  SETTINGS_PAGE_ROUTES,
  settingsOpenedFromHome,
  settingsPagesOnTop,
  workspaceDestinationChange,
  type WorkspaceDestination,
} from "../../apps/mobile/src/features/workspace/workspace-destinations";
import type { WorkspaceTab } from "../../apps/mobile/src/features/workspace/workspace-tabs-state";

// Load the same router as native navigation without importing React Native into Node.
const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(
    new URL("../../apps/mobile/package.json", import.meta.url).pathname,
  ).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions, CommonActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
};

type State = StackNavigationState<ParamListBase>;
const ROUTE_NAMES = ["Home", "Thread", "Hosts", ...SETTINGS_PAGE_ROUTES];
const options = { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} };
const router = StackRouter({});

function history(names: readonly string[]): State {
  return {
    key: "root",
    type: "stack",
    stale: false,
    index: names.length - 1,
    routeNames: ROUTE_NAMES,
    routes: names.map((name, index) => ({ key: `${name}-${index}`, name })),
    preloadedRoutes: [],
  };
}

function apply(state: State, action: Parameters<typeof router.getStateForAction>[1]): State {
  const next = router.getStateForAction(state, action, options);
  if (!next || next.stale !== false) throw new Error("Expected a router history");
  return next as State;
}

/** What the destination hook does: pop, select the tab, then open Settings. */
function choose(state: State, tab: WorkspaceTab, destination: WorkspaceDestination) {
  const change = workspaceDestinationChange(state, tab, destination);
  let next = state;
  if (change.pop > 0) next = apply(next, StackActions.pop(change.pop));
  if (change.openSettings) next = apply(next, CommonActions.navigate("Settings"));
  return { state: next, tab: change.select ?? tab };
}

const names = (state: State) => state.routes.map((route) => route.name);

describe("Android Settings destination", () => {
  it("opens over Home with the bar, keeps it under nested pages, and Back returns Home", () => {
    const home = history(["Home"]);
    const settings = choose(home, "chats", "settings").state;
    expect(names(settings)).toEqual(["Home", "Settings"]);
    expect(settings.routes[0]?.key).toBe(home.routes[0]?.key);
    expect(settingsPagesOnTop(settings)).toBe(1);
    expect(settingsOpenedFromHome(settings)).toBe(true);

    const about = apply(settings, CommonActions.navigate("About"));
    expect(settingsPagesOnTop(about)).toBe(2);
    expect(settingsOpenedFromHome(about)).toBe(true);
    // Choosing Settings again while it is shown changes nothing.
    expect(workspaceDestinationChange(about, "chats", "settings")).toEqual({ pop: 0, select: null, openSettings: false });

    const back = apply(apply(about, StackActions.pop()), StackActions.pop());
    expect(names(back)).toEqual(["Home"]);
    expect(settingsPagesOnTop(back)).toBe(0);
  });

  it("returns from a nested settings page to the list, selecting a different tab only when asked", () => {
    const about = apply(choose(history(["Home"]), "chats", "settings").state, CommonActions.navigate("About"));
    const sameTab = choose(about, "chats", "chats");
    expect(names(sameTab.state)).toEqual(["Home"]);
    expect(sameTab.tab).toBe("chats");
    expect(workspaceDestinationChange(about, "chats", "chats").select).toBeNull();

    const otherTab = choose(about, "chats", "pullRequests");
    expect(names(otherTab.state)).toEqual(["Home"]);
    expect(otherTab.tab).toBe("pullRequests");
  });

  it("keeps the conversation under Settings opened over it", () => {
    const settings = choose(history(["Home", "Thread"]), "chats", "settings").state;
    expect(names(settings)).toEqual(["Home", "Thread", "Settings"]);
    // A phone shows no bar here: Back belongs to the conversation.
    expect(settingsOpenedFromHome(settings)).toBe(false);
    expect(settingsPagesOnTop(settings)).toBe(1);

    const sameTab = choose(settings, "chats", "chats");
    expect(names(sameTab.state)).toEqual(["Home", "Thread"]);
    expect(sameTab.state.routes[1]?.key).toBe(settings.routes[1]?.key);

    // A split layout shows the Pull Requests list in Home's detail pane.
    const otherTab = choose(settings, "chats", "pullRequests");
    expect(names(otherTab.state)).toEqual(["Home"]);
    expect(otherTab.tab).toBe("pullRequests");
  });

  it("does not select Settings for a settings page opened from elsewhere", () => {
    const hostSettings = history(["Home", "Hosts", "HostSettings"]);
    expect(settingsPagesOnTop(hostSettings)).toBe(0);
    expect(settingsOpenedFromHome(hostSettings)).toBe(false);
    expect(workspaceDestinationChange(hostSettings, "chats", "chats")).toEqual({ pop: 0, select: null, openSettings: false });
    // A page pushed from Settings that is not a settings page ends the destination.
    expect(settingsPagesOnTop(history(["Home", "Settings", "Hosts"]))).toBe(0);
  });

  it("leaves the list tab alone on Home when it is already shown", () => {
    expect(workspaceDestinationChange(history(["Home"]), "pullRequests", "pullRequests")).toEqual({ pop: 0, select: null, openSettings: false });
    expect(workspaceDestinationChange(history(["Home"]), "chats", "pullRequests")).toEqual({ pop: 0, select: "pullRequests", openSettings: false });
  });

  it("frames exactly the pages that select Settings", () => {
    const source = readFileSync(new URL("../../apps/mobile/src/navigation/RootNavigator.tsx", import.meta.url), "utf8");
    const group = source.match(/<Stack\.Group screenLayout=[\s\S]*?<\/Stack\.Group>/)?.[0] ?? "";
    expect(group).toContain("WorkspaceSettingsFrame");
    const framed = [...group.matchAll(/name="([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(new Set(framed)).toEqual(new Set(SETTINGS_PAGE_ROUTES));
  });
});
