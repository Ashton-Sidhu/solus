import { expect, it } from "vite-plus/test";
import type { ModelProfile } from "@solus/contracts/types";
import { visibleCatalogModels } from "../features/threads/thread-settings-sheet-state";
import { solusModelGroup } from "./model-picker-catalog";

it("uses host model groups in the upstream picker", () => {
  const profile: ModelProfile = {
    label: "Host model",
    reasoningLevels: ["medium"],
    defaultReasoningEffort: "medium",
    supportsFastMode: false,
    contextWindows: [200_000],
    defaultContextWindow: 200_000,
  };
  const group = solusModelGroup({
    id: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    models: [
      { id: "claude-opus-4-6", label: "Current on this host" },
      { id: "older", label: "Legacy on this host" },
      { id: "new", label: "New on this host" },
    ],
    modelProfiles: {
      "claude-opus-4-6": { ...profile, isLegacy: false },
      older: { ...profile, isLegacy: true },
    },
  });

  const visible = (options: Partial<Parameters<typeof visibleCatalogModels>[0]> = {}) =>
    visibleCatalogModels({
      models: group.models,
      providerLabel: group.providerLabel,
      query: "",
      favoriteKeys: new Set(),
      favoritesOnly: false,
      showLegacy: false,
      isDisplayed: () => false,
      ...options,
    }).map((model) => model.selection.model);

  expect(visible()).toEqual(["claude-opus-4-6", "new"]);
  expect(visible({ isDisplayed: (model) => model.selection.model === "older" })).toEqual([
    "claude-opus-4-6",
    "older",
    "new",
  ]);
  expect(visible({ showLegacy: true })).toEqual(["claude-opus-4-6", "older", "new"]);
  expect(visible({ query: "Legacy" })).toEqual(["older"]);
  expect(visible({ favoriteKeys: new Set(["claudeAgent:older"]) })).toEqual([
    "older",
    "claude-opus-4-6",
    "new",
  ]);
  expect(group.models[0]).toMatchObject({ subtitle: "", isDefault: true });
});
