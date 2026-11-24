import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { buildHomeListFilterMenuItems, homeListFilterEnvironments } from "./home-list-filter-menu";

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});

it("can add the first project from the sidebar project menu", () => {
  let opened = false;
  const items = buildHomeListFilterMenuItems({
    environments: [],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    onEnvironmentChange: () => {},
    onProjectChange: () => {},
    onAddProject: () => { opened = true; },
  });
  const project = items.find(({ id }) => id === "project");
  const add = project && "items" in project ? project.items[0] : undefined;
  if (!add || !("onPress" in add)) throw new Error("Expected the Add project action");
  add.onPress();
  expect(opened).toBe(true);
});
