import { describe, expect, it } from "vite-plus/test";
import { automationEditPatch, editedTrigger, weeklySchedule } from "./automation-settings";

describe("Solus schedules in the T3 editor", () => {
  it("keeps the host time zone, expression and end date when editing a recurring task", () => {
    const saved = {
      type: "cron",
      expr: "*/15 8-17 * * 1-5",
      timezone: "America/Toronto",
      endsAt: "2027-01-01T05:00:00Z",
    } as const;
    expect(weeklySchedule(saved.expr)).toBeNull();
    expect(editedTrigger("cron", saved.expr, saved.timezone, saved)).toEqual(saved);
  });
  it("shows the host's hour and days without converting them to the phone's time zone", () => {
    expect(weeklySchedule("30 9 * * 1-5")).toEqual({ hour: 9, minute: 30, days: "1,2,3,4,5" });
    expect(weeklySchedule("0 0 * * *")?.days).toBe("0,1,2,3,4,5,6");
    expect(weeklySchedule("15 24 * * 1,2")).toBeNull();
  });
  it("preserves the end of a repeating interval and rejects invalid intervals", () => {
    const endsAt = "2027-02-03T00:00:00Z";
    expect(
      editedTrigger("interval", "30", "", { type: "interval", everyMinutes: 15, endsAt }),
    ).toEqual({ type: "interval", everyMinutes: 30, endsAt });
    for (const value of ["", "3.5", "0", "NaN"])
      expect(() => editedTrigger("interval", value, "")).toThrow();
  });
  it("sends absolute time for one-time tasks and no timer for manual tasks", () => {
    expect(editedTrigger("once", "2026-11-29T09:00:00-05:00", "")).toEqual({
      type: "once",
      runAt: "2026-11-29T14:00:00.000Z",
    });
    expect(editedTrigger("manual", "", "")).toEqual({ type: "manual" });
  });
});

it("renaming a task preserves the host's schedule, permission snapshot and action settings", () => {
  const saved = {
    name: "Review",
    enabled: true,
    trigger: { type: "manual" },
    action: {
      prompt: "Inspect changes",
      agentProvider: "codex",
      cwd: "/repo",
      modelId: null,
      reasoningEffort: "high",
      workRefs: [],
    },
  } as const;
  expect(
    automationEditPatch(
      { ...saved, action: { ...saved.action, workRefs: [] } },
      { ...saved, name: "Review changes" },
    ),
  ).toEqual({ name: "Review changes", action: {} });
});

it("saves task-specific effort and can turn off Fast Mode", () => {
  const saved = {
    name: "Review",
    enabled: true,
    trigger: { type: "manual" },
    action: {
      prompt: "Inspect changes",
      agentProvider: "codex",
      cwd: "/repo",
      modelId: "gpt-6.2-sol",
      reasoningEffort: "medium",
      fastMode: true,
    },
  } as const;
  expect(automationEditPatch(saved, {
    ...saved,
    action: { ...saved.action, reasoningEffort: "high", fastMode: false },
  })).toEqual({ action: { reasoningEffort: "high", fastMode: false } });
});
