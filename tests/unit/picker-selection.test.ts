/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { AgentMetadata, ModelProfile, ReasoningEffort } from "@solus/contracts/types";
import {
  defaultModelIdFor,
  modelPickerFocusTarget,
  modelPickerNavigationTarget,
  pickClosesModelPicker,
  reasoningLevelsFor,
  reservedReasoningRows,
  isSessionSettingsShortcutTarget,
  splitLegacyModels,
  supportsFastModeFor,
} from "@solus/workspace-ui/components/pickers/lib/picker-selection";

describe("legacy model disclosure", () => {
  const CLAUDE = [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ];

  test("keeps the superseded generation out of the column it is collapsed under", () => {
    // WHY: the model column is a shortlist. Every profile stays selectable, but
    // only the generation we expect people to pick is on screen by default.
    const { current, legacy } = splitLegacyModels("claude-code", CLAUDE);
    expect(current.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(legacy.map((model) => model.id)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  test("holds the provider's own order inside each section", () => {
    // WHY: the backend lists newest first. Sorting either half would bury the
    // model most people came for under the one they were avoiding.
    const { current } = splitLegacyModels("claude-code", [...CLAUDE].reverse());
    expect(current.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });

  test("treats a model the profile table does not know as current", () => {
    // WHY: an unreported model is far likelier to be newly shipped than retired,
    // and hiding it would make it unreachable rather than merely quiet.
    const { current, legacy } = splitLegacyModels("claude-code", [
      { id: "claude-opus-6", label: "Opus 6" },
    ]);
    expect(current.map((model) => model.id)).toEqual(["claude-opus-6"]);
    expect(legacy).toHaveLength(0);
  });

  test("leaves the disclosure off entirely when nothing is superseded", () => {
    const { legacy } = splitLegacyModels("claude-code", [
      { id: "claude-opus-5-5", label: "Opus 5.5" },
    ]);
    expect(legacy).toHaveLength(0);
  });
});

describe("model picker shortcut target", () => {
  test("opens the primary draft picker when the shortcut is unaddressed", () => {
    // WHY: a new-session draft has no tab id, but its local model choice is the
    // one the visible primary composer will use when it starts the session.
    expect(
      isSessionSettingsShortcutTarget({
        isPrimary: true,
        tabId: undefined,
        targetTabId: undefined,
      }),
    ).toBe(true);
  });

  test("keeps an addressed shortcut scoped to its session", () => {
    expect(
      isSessionSettingsShortcutTarget({
        isPrimary: true,
        tabId: undefined,
        targetTabId: "tab-1",
      }),
    ).toBe(false);
    expect(
      isSessionSettingsShortcutTarget({
        isPrimary: false,
        tabId: "tab-1",
        targetTabId: "tab-1",
      }),
    ).toBe(true);
  });
});

describe("model picker keyboard navigation", () => {
  test("vertical movement stays in its visual column", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowDown",
        column: "model",
        index: 2,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 1,
      }),
    ).toEqual({ column: "model", index: 3 });

    expect(
      modelPickerNavigationTarget({
        key: "ArrowDown",
        column: "model",
        index: 3,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 1,
      }),
    ).toEqual({ column: "model", index: 3 });
  });

  test("right reaches the preferred reasoning level without traversing every model", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowRight",
        column: "model",
        index: 2,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 3,
      }),
    ).toEqual({ column: "reasoning", index: 3 });
  });

  test("left returns to the model whose reasoning is being previewed", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowLeft",
        column: "reasoning",
        index: 3,
        columnLength: 5,
        oppositeColumnLength: 4,
        preferredOppositeIndex: 2,
      }),
    ).toEqual({ column: "model", index: 2 });
  });

  test("right remains available to open the Agent submenu", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowRight",
        column: "reasoning",
        index: 4,
        columnLength: 5,
        oppositeColumnLength: 4,
        preferredOppositeIndex: 2,
      }),
    ).toBeNull();
  });
});

describe("model picker fast mode", () => {
  test("offers fast mode only when the selected provider model supports it", () => {
    expect(supportsFastModeFor("codex", "gpt-5.6-sol")).toBe(true);
    expect(supportsFastModeFor("codex", "gpt-5.3-codex")).toBe(false);
    expect(supportsFastModeFor("claude-code", "claude-opus-5")).toBe(false);
  });

});


describe("model picker provider defaults", () => {
  test("saved provider choices override the catalog and the host default in both directions", () => {
    const metadata: { codex: AgentMetadata; "claude-code": AgentMetadata } = {
      codex: { id: "codex", label: "Codex", defaultModel: "gpt-6-astra", models: [] },
      "claude-code": { id: "claude-code", label: "Claude", defaultModel: "claude-opus-5-5", models: [] },
    };
    expect(defaultModelIdFor("codex", metadata, "gpt-5.4")).toBe("gpt-5.4");
    expect(defaultModelIdFor("claude-code", metadata, "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(defaultModelIdFor("codex", metadata, "gpt-5.4")).toBe("gpt-5.4");
  });
  test("fresh installs use the profile default rather than another host default", () => {
    const metadata: { codex: AgentMetadata } = { codex: { id: "codex", label: "Codex", defaultModel: "gpt-6-luna", models: [] } };
    expect(defaultModelIdFor("codex", metadata)).toBe("gpt-6-astra");
    expect(defaultModelIdFor("codex", metadata, "gpt-5.4")).toBe("gpt-5.4");
  });
  test("Auto is only selected where a first prompt can route it", () => {
    expect(defaultModelIdFor("codex", {}, "auto")).toBe("auto");
    expect(defaultModelIdFor("codex", {}, "auto", false)).toBe("gpt-6-astra");
  });
});

function profile(label: string, reasoningLevels: ReasoningEffort[], supportsFastMode = false): ModelProfile {
  return {
    label,
    reasoningLevels,
    defaultReasoningEffort: reasoningLevels[0] ?? "high",
    supportsFastMode,
    contextWindows: [200_000],
    defaultContextWindow: 200_000,
  };
}

function agent(id: "claude-code" | "codex", profiles: Record<string, ModelProfile>): AgentMetadata {
  return {
    id,
    label: id,
    models: Object.entries(profiles).map(([modelId, { label }]) => ({ id: modelId, label })),
    modelProfiles: profiles,
  };
}

const PICKER_METADATA = {
  "claude-code": agent("claude-code", {
    big: profile("Big", ["low", "medium", "high", "xhigh", "max", "ultracode"]),
    small: profile("Small", ["low", "medium", "high"]),
  }),
  codex: agent("codex", {
    quick: profile("Quick", ["low", "medium", "high"], true),
    deep: profile("Deep", ["low", "medium", "high", "xhigh"]),
  }),
};

describe("model picker levels", () => {
  test("the Reasoning column offers the model's own levels", () => {
    // WHY: a level the model does not take would be sent and silently clamped.
    expect(reasoningLevelsFor("claude-code", "small", PICKER_METADATA["claude-code"])).toEqual(["low", "medium", "high"]);
    expect(reasoningLevelsFor("claude-code", "big", PICKER_METADATA["claude-code"])).toHaveLength(6);
  });

  test("reserves the deepest column any agent's model needs, Fast mode included", () => {
    // WHY: the popup keeps one size. Switching agent or crossing models must not
    // resize it under the cursor, so the reservation spans every agent on offer.
    expect(reservedReasoningRows(["claude-code", "codex"], PICKER_METADATA, true)).toBe(6);
    // Quick has 3 levels and Fast mode, Deep has 4 levels: both fill 4 rows.
    expect(reservedReasoningRows(["codex"], PICKER_METADATA, true)).toBe(4);
    expect(reservedReasoningRows(["codex"], { codex: agent("codex", { quick: profile("Quick", ["low", "medium", "high", "xhigh"], true) }) }, true)).toBe(5);
    // A host that cannot send Fast mode never shows the switch, so reserves no row for it.
    expect(reservedReasoningRows(["codex"], { codex: agent("codex", { quick: profile("Quick", ["low", "medium", "high", "xhigh"], true) }) }, false)).toBe(4);
  });
});

describe("model picker focus", () => {
  const levels: ReasoningEffort[] = ["low", "medium", "high"];

  test("opening lands on the current model, one → away from its levels", () => {
    expect(modelPickerFocusTarget({ reason: "open", modelId: "big", effort: "medium", levels })).toEqual({ column: "model", value: "big" });
  });

  test("picking a model keeps the picker on that model's current level", () => {
    // WHY: model then effort is one flow; the pick must not drop focus back to
    // the top of the list or close the picker.
    expect(modelPickerFocusTarget({ reason: "model-picked", modelId: "small", effort: "high", levels })).toEqual({ column: "reasoning", value: "high" });
  });

  test("the shortcut while open jumps to the current level", () => {
    expect(modelPickerFocusTarget({ reason: "shortcut", modelId: "big", effort: "low", levels })).toEqual({ column: "reasoning", value: "low" });
  });

  test("an effort the new model does not offer lands on its first level, never on nothing", () => {
    expect(modelPickerFocusTarget({ reason: "model-picked", modelId: "small", effort: "ultracode", levels })).toEqual({ column: "reasoning", value: "low" });
  });

  test("a model with no levels to pick keeps focus on the model", () => {
    // WHY: Auto routes with fixed options, so its levels are disabled; focus on
    // a disabled row would strand the keyboard.
    expect(modelPickerFocusTarget({ reason: "model-picked", modelId: "auto", effort: "medium", levels: [] })).toEqual({ column: "model", value: "auto" });
  });
});

describe("model picker closing", () => {
  test("an effort is the final choice: it closes the picker", () => {
    // WHY: once the effort is chosen the next step is typing, so the picker gets
    // out of the way and focus returns to the input bar.
    expect(pickClosesModelPicker("effort")).toBe(true);
  });

  test("a model, Fast mode, or an agent is a step on the way and keeps it open", () => {
    // WHY: model then effort is one flow. Closing on the model pick would make
    // the person reopen the picker to choose the effort that goes with it.
    expect(pickClosesModelPicker("model")).toBe(false);
    expect(pickClosesModelPicker("fast-mode")).toBe(false);
    expect(pickClosesModelPicker("agent")).toBe(false);
  });
});
