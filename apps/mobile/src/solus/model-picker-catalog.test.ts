import { expect, it } from "vite-plus/test";
import type { ModelProfile } from "@solus/contracts/types";
import { newProviderInstance } from "@solus/contracts/provider-instances";
import { visibleCatalogModels } from "../features/threads/thread-settings-sheet-state";
import { pickerRunOptions, solusModelGroup } from "./model-picker-catalog";

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

  const visible = (
    options: Partial<Parameters<typeof visibleCatalogModels>[0]> = {},
  ) =>
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
  expect(
    visible({ isDisplayed: (model) => model.selection.model === "older" }),
  ).toEqual(["claude-opus-4-6", "older", "new"]);
  expect(visible({ showLegacy: true })).toEqual([
    "claude-opus-4-6",
    "older",
    "new",
  ]);
  expect(visible({ query: "Legacy" })).toEqual(["older"]);
  expect(visible({ favoriteKeys: new Set(["claudeAgent:older"]) })).toEqual([
    "older",
    "claude-opus-4-6",
    "new",
  ]);
  expect(group.models[0]).toMatchObject({ subtitle: "", isDefault: true });
});

it("offers and applies only the options the host model supports", () => {
  const profile: ModelProfile = {
    label: "Host model",
    reasoningLevels: ["low", "xhigh"],
    defaultReasoningEffort: "xhigh",
    supportsFastMode: true,
    contextWindows: [200_000],
    defaultContextWindow: 200_000,
  };
  const agent = {
    id: "codex" as const,
    label: "Codex",
    defaultModel: "host-model",
    models: [{ id: "host-model", label: profile.label }],
    modelProfiles: { "host-model": profile },
  };
  const model = solusModelGroup(agent, {
    defaultModels: {},
    modelOptionsByProvider: {
      codex: {
        "host-model": {
          reasoningEffort: "low",
          contextWindow: null,
          fastMode: true,
        },
      },
    },
  }).models[0]!;
  expect(model.selection.options).toEqual([
    { id: "effort", value: "low" },
    { id: "fastMode", value: true },
  ]);
  expect(
    pickerRunOptions(model, [
      { id: "effort", value: "medium" },
      { id: "fastMode", value: false },
    ]),
  ).toEqual({ fastMode: false });
  expect(
    pickerRunOptions(model, [
      { id: "effort", value: "xhigh" },
      { id: "fastMode", value: true },
    ]),
  ).toEqual({ reasoningEffort: "xhigh", fastMode: true });

  const claude = solusModelGroup({ ...agent, id: "claude-code" }).models[0]!;
  expect(claude.capabilities?.optionDescriptors).toMatchObject([
    { id: "effort", promptInjectedValues: ["ultrathink"] },
  ]);
  expect(
    pickerRunOptions(claude, [
      { id: "effort", value: "ultrathink" },
      { id: "fastMode", value: true },
    ]),
  ).toEqual({});
});

it("lets the picker restore a hidden model and protects the current default", () => {
  const profile: ModelProfile = {
    label: "Model",
    reasoningLevels: ["medium"],
    defaultReasoningEffort: "medium",
    supportsFastMode: false,
    contextWindows: [200_000],
    defaultContextWindow: 200_000,
  };
  const instance = {
    ...newProviderInstance("codex", "codex", "Codex"),
    binaryAvailable: true,
    hiddenModels: ["older"],
  };
  const group = solusModelGroup(
    {
      id: "codex",
      label: "Codex",
      defaultModel: "current",
      models: [{ id: "current", label: "Current" }],
      modelProfiles: {
        current: { ...profile, isDefault: true },
        older: profile,
      },
    },
    null,
    instance,
  );
  expect(
    group.models.map(({ selection, isHidden, canHide }) => ({
      model: selection.model,
      isHidden,
      canHide,
    })),
  ).toEqual([
    { model: "current", isHidden: false, canHide: false },
    { model: "older", isHidden: true, canHide: true },
  ]);
});
