import type { Automation, AutomationAction, AutomationTrigger } from "@solus/contracts/types";

export function automationScheduleText(trigger: AutomationTrigger) {
  switch (trigger.type) {
    case "manual":
      return "Manual";
    case "once":
      return "Once · " + new Date(trigger.runAt).toLocaleString();
    case "interval":
      return "Every " + trigger.everyMinutes + " min";
    case "cron":
      return [trigger.expr, trigger.timezone].filter(Boolean).join(" · ");
  }
}

export function editedTrigger(
  mode: AutomationTrigger["type"],
  value: string,
  zone: string,
  saved?: AutomationTrigger,
): AutomationTrigger {
  const end = saved && "endsAt" in saved && saved.endsAt ? { endsAt: saved.endsAt } : {};
  if (mode === "manual") return { type: "manual" };
  if (mode === "once") {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) throw new Error("Choose a valid date and time.");
    return { type: "once", runAt: time.toISOString() };
  }
  if (mode === "interval") {
    const minutes = Number(value);
    if (!Number.isSafeInteger(minutes) || minutes < 1)
      throw new Error("Enter a positive number of whole minutes.");
    return { type: "interval", everyMinutes: minutes, ...end };
  }
  if (!value.trim()) throw new Error("Enter a cron schedule.");
  if (zone.trim()) new Intl.DateTimeFormat(undefined, { timeZone: zone.trim() });
  return {
    type: "cron",
    expr: value.trim(),
    ...(zone.trim() ? { timezone: zone.trim() } : {}),
    ...end,
  };
}

/** T3's time and repeat controls edit only fixed weekly schedules. Keep other cron expressions intact. */
export function weeklySchedule(expr: string) {
  const parts = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-6](?:,[0-6])*)$/.exec(expr.trim());
  if (!parts || Number(parts[1]) > 59 || Number(parts[2]) > 23) return null;
  const days = parts[3] === "*" ? "0,1,2,3,4,5,6" : parts[3] === "1-5" ? "1,2,3,4,5" : parts[3]!;
  return { hour: Number(parts[2]), minute: Number(parts[1]), days };
}

/** Send only what the editor changed so edits to other fields on another device survive. */
export function automationEditPatch(
  saved: Pick<Automation, "name" | "enabled" | "trigger" | "action">,
  edit: {
    name: string;
    enabled: boolean;
    trigger: AutomationTrigger;
    action: Pick<AutomationAction, "prompt" | "modelId" | "agentProvider" | "cwd" | "useWorktree"> &
      Partial<Pick<AutomationAction, "reasoningEffort" | "fastMode">>;
  },
) {
  const { action } = edit;
  return {
    ...(edit.name !== saved.name && { name: edit.name }),
    ...(edit.enabled !== saved.enabled && { enabled: edit.enabled }),
    ...(JSON.stringify(edit.trigger) !== JSON.stringify(saved.trigger) && {
      trigger: edit.trigger,
    }),
    action: {
      ...(action.prompt !== saved.action.prompt && { prompt: action.prompt }),
      ...(action.modelId !== saved.action.modelId && { modelId: action.modelId }),
      ...(action.agentProvider !== saved.action.agentProvider && {
        agentProvider: action.agentProvider,
      }),
      ...(action.reasoningEffort !== undefined && action.reasoningEffort !== saved.action.reasoningEffort && {
        reasoningEffort: action.reasoningEffort,
      }),
      ...(action.fastMode !== undefined && action.fastMode !== (saved.action.fastMode ?? false) && {
        fastMode: action.fastMode,
      }),
      ...(action.cwd !== saved.action.cwd && { cwd: action.cwd }),
      ...(!!action.useWorktree !== !!saved.action.useWorktree && {
        useWorktree: action.useWorktree,
      }),
    },
  };
}
