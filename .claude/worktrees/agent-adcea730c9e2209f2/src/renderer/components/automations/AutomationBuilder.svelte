<script lang="ts">
  import {
    PlayIcon,
    StopIcon,
    CircleNotchIcon,
    CheckIcon,
    CheckCircleIcon,
    ChatCircleDotsIcon,
    WarningCircleIcon,
    ProhibitIcon,
    CaretRightIcon,
    GitBranchIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type {
    Automation,
    AutomationAction,
    AutomationPlanRef,
    AutomationTrigger,
    AgentId,
    PlanReference,
    ReasoningEffort,
    WorkReference,
  } from "../../../shared/types";
  import { REASONING_EFFORT_LABELS } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { getPlanStore } from "../../contexts/plan.store.svelte";
  import { agentLabel } from "../../lib/agentAvailability";
  import * as Select from "../ui/select";
  import { Input } from "../ui/input";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import DateTimePicker from "../ui/DateTimePicker.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import {
    type BuilderTriggerKind,
    builderKindFor,
    dailyCron,
    weeklyCron,
    monthlyCron,
    cronHHMM,
    cronWeekday,
    cronMonthDay,
    intervalParts,
    INTERVAL_UNIT_MINUTES,
    toLocalInputValue,
    absoluteTime,
    nextOccurrences,
    relativeTime,
    runDate,
    runDuration,
    WEEKDAYS,
    RUN_STATUS_META,
  } from "./lib/automation-format";
  import { formatSavedAgo } from "../document-shell/saveStatus";

  import { untrack } from "svelte";

  import type { PaneSlot } from "../../contexts/pane-view.store.svelte";

  interface Props {
    automation: Automation | null;
    onDone: () => void;
    /** Rendered inside a side-panel pane: show a fixed chrome header (title +
     *  run + split/focus + close) instead of the full-page breadcrumb bar. */
    inline?: boolean;
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
    onClose?: () => void;
  }
  let {
    automation,
    onDone,
    inline = false,
    slot = "primary",
    onOpenInSplit,
    onClose,
  }: Props = $props();

  // Sidebar background — also used by the inline pane container. Kept a hair
  // warmer than the page so the rail reads as its own surface.
  const SIDEBAR_PANEL_BG =
    "bg-[color:color-mix(in_srgb,var(--solus-container-bg)_90%,color-mix(in_srgb,var(--solus-input-pill-bg)_70%,var(--solus-surface-primary))_10%)]";
  // Flat, card-less rail (mirrors PrActivityRail's Activity sidebar): sections
  // are separated by a hairline art rule rather than boxed in card chrome. The
  // first section carries no top border; SECTION_DIVIDED adds one. Titles are
  // quiet uppercase micro-caps.
  const SECTION = "flex flex-col gap-3";
  const SECTION_DIVIDED =
    "flex flex-col gap-3 border-t border-(--solus-art-border) pt-5";
  const SECTION_TITLE =
    "text-[0.6875rem] font-semibold uppercase tracking-wider text-(--solus-text-tertiary)";

  // Metadata rows: a muted label / prominent value hierarchy with whitespace
  // separation (no dividers), so the content reads aligned but uncluttered.
  // ROW lays out one label↔value line; META_VALUE styles text values.
  const META =
    "flex flex-col gap-0.5 " +
    "[&_dt]:shrink-0 [&_dt]:text-xs [&_dt]:text-(--solus-text-tertiary) " +
    "[&_dd]:m-0 [&_dd]:min-w-0";
  const ROW = "flex items-center justify-between gap-3 min-h-[1.875rem]";
  // Ghost select trigger: borderless, compact, lifts on hover. `sel-ghost` is
  // an inert marker the trigger column uses to retarget the hover tint.
  const GHOST_TRIGGER =
    "sel-ghost data-[size=default]:h-auto gap-1 border-0 bg-transparent px-1.5 py-1 text-xs " +
    "hover:bg-(--solus-surface-hover) dark:bg-transparent dark:hover:bg-(--solus-surface-hover) [&_svg]:size-[11px] [&_svg]:opacity-60";
  const TIME_FIELD =
    "sel-ghost scheme-light dark:scheme-dark h-6 w-[4.75rem] min-w-0 appearance-none rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[0.6875rem] tabular-nums " +
    "text-(--solus-text-primary) transition-[background-color,outline-color] duration-120 hover:bg-(--solus-accent-light) " +
    "focus-visible:border-transparent focus-visible:bg-(--solus-accent-light) focus-visible:ring-0 " +
    "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] " +
    "pointer-coarse:h-10 pointer-coarse:w-24 pointer-coarse:rounded-lg pointer-coarse:px-2 pointer-coarse:text-xs " +
    "[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none [&::-webkit-datetime-edit]:p-0";
  const META_VALUE =
    "block text-xs font-normal text-right text-(--solus-text-primary) truncate";

  // Borderless breadcrumb link / accent run button in the top bar.
  const CRUMB_LINK =
    "border-0 bg-transparent text-(--solus-text-tertiary) cursor-pointer px-1 py-0.5 rounded-md " +
    "transition-[color,background-color] duration-100 hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] " +
    "pointer-coarse:min-h-10 pointer-coarse:inline-flex pointer-coarse:items-center pointer-coarse:px-2";
  const RUN_BTN =
    "shrink-0 inline-flex items-center gap-1.5 px-3 py-[0.4375rem] rounded-lg border-0 text-xs font-semibold " +
    "text-[var(--solus-accent-contrast,#fff)] bg-(--solus-accent) cursor-pointer transition-[filter,opacity] duration-120 " +
    "hover:not-disabled:brightness-[1.07] disabled:opacity-60 disabled:cursor-not-allowed " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] " +
    "pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-sm";
  // Stop mirrors Run now but in the error tone — a clear "halt the in-flight run".
  const STOP_BTN =
    "shrink-0 inline-flex items-center gap-1.5 px-3 py-[0.4375rem] rounded-lg text-xs font-semibold cursor-pointer " +
    "transition-[filter,opacity] duration-120 text-[var(--solus-status-error,#e53e3e)] " +
    "border border-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_35%,transparent)] " +
    "bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_12%,transparent)] " +
    "hover:not-disabled:brightness-[1.05] disabled:opacity-60 disabled:cursor-not-allowed " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_55%,transparent)] " +
    "pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-sm";
  const TITLE_INPUT =
    "w-full text-2xl font-[650] tracking-[-0.02em] text-(--solus-text-primary) bg-transparent border-0 rounded-lg px-1 py-0.5 -ml-1 " +
    "[outline:0.0625rem_solid_transparent] transition-[outline-color,background-color] duration-120 placeholder:text-(--solus-text-tertiary) ";
  // Wraps the prompt editor as one tall field; the nested ProseMirror gets a
  // tall click target.
  const PROMPT_FIELD =
    "flex-1 flex flex-col min-h-0 w-full rounded-[0.625rem] px-2 -ml-2 bg-transparent [outline:0.0625rem_solid_transparent] transition-[outline-color,background-color] duration-120 " +
    "[&_.solus-md-editor-wrap]:flex-1 [&_.solus-md-editor-wrap]:flex [&_.solus-md-editor-wrap]:flex-col [&_.solus-md-editor-wrap]:min-h-0 " +
    "[&_.solus-md-editor]:flex-1 [&_.solus-md-editor]:flex [&_.solus-md-editor]:flex-col [&_.solus-md-editor]:min-h-0 " +
    "[&_.solus-md-editor_.ProseMirror]:flex-1 [&_.solus-md-editor_.ProseMirror]:min-h-0 [&_.solus-md-editor_.ProseMirror]:max-h-none! [&_.solus-md-editor_.ProseMirror]:![font-weight:400]";
  // Soft recessed input well shared by the schedule / max-turns fields. Variant
  // utilities (width, text-right, font-mono) are appended per field.
  const FIELD =
    "text-md text-(--solus-text-primary) bg-(--solus-surface-hover) rounded-lg px-2 py-[0.3125rem] border-0 " +
    "[outline:0.0625rem_solid_transparent] [color-scheme:light] [.dark_&]:[color-scheme:dark] transition-[background-color,outline-color] duration-120 " +
    "hover:bg-(--solus-accent-light) focus-visible:bg-[var(--solus-input-bg-soft,var(--solus-container-bg))] " +
    "focus-visible:[outline:0.125rem_solid_color-mix(in_srgb,var(--solus-accent)_55%,transparent)] " +
    "[&::-webkit-calendar-picker-indicator]:opacity-45 [&::-webkit-calendar-picker-indicator]:cursor-pointer hover:[&::-webkit-calendar-picker-indicator]:opacity-80 " +
    "pointer-coarse:min-h-11 pointer-coarse:px-2.5 pointer-coarse:py-2 pointer-coarse:text-base";
  // Number field chrome: textfield appearance, spinner buttons removed (width set per use).
  const FIELD_NUM =
    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
  const SUB_LABEL = "text-[0.6875rem] text-(--solus-text-tertiary) shrink-0";
  const RUN_ROW =
    "w-full flex items-center gap-2 px-2 py-[0.4375rem] rounded-lg border-0 bg-transparent cursor-pointer text-left transition-[background-color] duration-100 " +
    "hover:not-disabled:bg-(--solus-accent-light) disabled:cursor-default " +
    "focus-visible:outline-2 focus-visible:[outline-offset:-0.0625rem] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] " +
    "pointer-coarse:min-h-12 pointer-coarse:px-2.5 pointer-coarse:py-2.5";

  // Square icon button for the inline pane chrome (split / focus / close).
  const PANE_ICON_BTN =
    "inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent " +
    "text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out " +
    "hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent) " +
    "pointer-coarse:size-11";

  const session = getWorkspaceContext();
  const store = session.automationsStore;

  // Inline (pane) breadcrumb: leave the builder and reopen the full-page list.
  function paneBackToList() {
    onClose?.();
    session.openAutomations();
  }

  // Editor-mode builder renders as an artifact-viewer pane rather than the
  // `automationsOpen` overlay, so the full-page AutomationsPage scope (and its
  // Esc-to-close) never mounts here. Push the same scope for the pane so Esc
  // closes it. Gated on `inline` to avoid double-binding when the builder is
  // rendered inside the full-page list.
  useScope("automations", { active: () => inline });
  useKeybinding("automations.close", () => onClose?.(), {
    enabled: () => inline,
  });
  const agentContext = getAgentContext();
  const planStore = getPlanStore();

  // The live automation, read from the store by id so pushed changes (scheduler
  // fires, run transitions) update this view without a save. A brand-new
  // automation (prop === null) is created lazily on the first edit, so an
  // untouched "New" view leaves nothing behind.
  let currentId = $state<string | null>(untrack(() => automation?.id ?? null));
  // Fallback for the window between a save and the store echoing it (and for
  // rows the store list hasn't loaded).
  let savedSnapshot = $state<Automation | null>(untrack(() => automation));
  const current = $derived<Automation | null>(
    currentId ? (store.get(currentId) ?? savedSnapshot) : null,
  );

  // Only providers with a headless runner can back an automation.
  const RUNNABLE: AgentId[] = ["claude-code", "codex"];
  const agentOptions = $derived(
    agentContext.agents.filter(
      (a) => RUNNABLE.includes(a.id) && a.available !== false,
    ),
  );
  const REASONING_OPTIONS: ReasoningEffort[] = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];

  // ── Editable action drafts ──
  // Seeded once from the prop; `untrack` makes the one-time snapshot explicit so
  // the initializers don't read the reactive prop directly. `current` (above)
  // stays live for everything that should track later saves.
  const initial = untrack(() => automation);
  let name = $state(initial?.name ?? "");
  let prompt = $state(initial?.action.prompt ?? "");
  // Plan/work references the prompt embeds (via `#` / `%`). `composerPlanRefs`
  // mirrors the editor's tokens; `planSources` carries each plan's resolved
  // file path / content so a headless run can find it — seeded from the saved
  // automation so re-edits never lose a source the plan store hasn't reloaded.
  let composerPlanRefs = $state<PlanReference[]>([]);
  let workRefs = $state<WorkReference[]>(initial?.action.workRefs ?? []);
  const planSources = new Map<string, AutomationPlanRef>(
    (initial?.action.planRefs ?? []).map((r) => [r.planId, r]),
  );
  let agentProvider = $state<AgentId>(
    initial?.action.agentProvider ?? "claude-code",
  );
  let modelId = $state<string | null>(initial?.action.modelId ?? null);
  let reasoningEffort = $state<ReasoningEffort>(
    initial?.action.reasoningEffort ?? "medium",
  );
  let cwd = $state(initial?.action.cwd ?? session.galleryProjectPath);
  let useWorktree = $state(initial?.action.useWorktree ?? false);
  let enabled = $state(initial?.enabled ?? true);

  // ── Trigger drafts (mirror the stored trigger; "Repeats" drives `kind`) ──
  const t0 = initial?.trigger;
  let kind = $state<BuilderTriggerKind>(
    initial ? builderKindFor(initial.trigger) : "manual",
  );
  let timeStr = $state(t0?.type === "cron" ? cronHHMM(t0.expr) : "09:00");
  let weekday = $state(t0?.type === "cron" ? cronWeekday(t0.expr) : 1);
  let monthDay = $state(t0?.type === "cron" ? cronMonthDay(t0.expr) : 1);
  let intervalValue = $state(
    t0?.type === "interval" ? intervalParts(t0.everyMinutes).value : 1,
  );
  let intervalUnit = $state<"minutes" | "hours" | "days">(
    t0?.type === "interval" ? intervalParts(t0.everyMinutes).unit : "hours",
  );
  let cronExpr = $state(t0?.type === "cron" ? t0.expr : "0 9 * * *");
  let onceLocal = $state(
    toLocalInputValue(t0?.type === "once" ? t0.runAt : undefined),
  );

  // ── Select option lists ──
  const models = $derived(agentContext.metadata[agentProvider]?.models ?? []);
  const agentSelectOptions = $derived(
    agentOptions.length > 0
      ? agentOptions.map((a) => ({
          value: a.id,
          label: agentLabel(a.id, agentContext.metadata),
        }))
      : [{ value: "claude-code" as AgentId, label: "Claude" }],
  );
  const modelSelectOptions = $derived(
    models.map((m) => ({ value: m.id as string | null, label: m.label })),
  );
  // `modelId: null` means "the provider's default model" — display it as the
  // first model without writing it back. Pinning + saving here used to fire on
  // mount, creating a ghost "Untitled automation" the moment the New view opened.
  const effectiveModelId = $derived(modelId ?? models[0]?.id ?? null);
  const reasoningSelectOptions = REASONING_OPTIONS.map((r) => ({
    value: r,
    label: REASONING_EFFORT_LABELS[r] ?? r,
  }));
  const repeatOptions: { value: BuilderTriggerKind; label: string }[] = [
    { value: "manual", label: "Manual" },
    { value: "interval", label: "On an interval" },
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "once", label: "Once" },
    { value: "cron", label: "Custom (cron)" },
  ];
  const intervalUnitOptions = [
    { value: "minutes" as const, label: "minutes" },
    { value: "hours" as const, label: "hours" },
    { value: "days" as const, label: "days" },
  ];
  const weekdayOptions = WEEKDAYS.map((d) => ({
    value: d.value,
    label: d.label,
  }));

  const projectName = $derived(cwd.split("/").filter(Boolean).pop() ?? cwd);
  // In-session ("heartbeat") automations run inside the chat thread they were
  // created in. The builder can't create them (agent-only), but it must show
  // what they are — and hide the worktree toggle, which is ignored for them.
  const inSession = $derived(!!current?.action.sessionId);

  // Run history for the live automation. Keyed on the id (not `current`, which
  // is replaced on every save/push) so history only reloads when the id changes;
  // subsequent run updates arrive over the automations-changed push.
  const runsKey = $derived(current?.id ?? null);
  const runs = $derived(runsKey ? (store.runs.get(runsKey) ?? []) : []);
  $effect(() => {
    if (runsKey) void store.loadRuns(runsKey);
  });

  // Minute-ish ticker so "Next run" / "Last ran" stay truthful while the
  // builder sits open (a fired schedule also pushes a fresh nextRunAt).
  let nowTick = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowTick = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // ── Trigger / action assembly ──
  function parseHHMM(s: string): { hh: number; mm: number } {
    const [h, m] = s.split(":").map(Number);
    return { hh: Number.isFinite(h) ? h : 9, mm: Number.isFinite(m) ? m : 0 };
  }

  // "Once" run-at, edited via the reusable DateTimePicker (datetime-local format).
  function setOnceAt(v: string) {
    onceLocal = v;
    commitTrigger();
  }

  function buildTrigger(): AutomationTrigger | { error: string } {
    const { hh, mm } = parseHHMM(timeStr);
    switch (kind) {
      case "manual":
        return { type: "manual" };
      case "once": {
        const ms = Date.parse(onceLocal);
        if (!Number.isFinite(ms))
          return { error: "Pick a valid date and time." };
        return { type: "once", runAt: new Date(ms).toISOString() };
      }
      case "interval": {
        const everyMinutes =
          Math.round(intervalValue) * INTERVAL_UNIT_MINUTES[intervalUnit];
        if (!Number.isFinite(everyMinutes) || everyMinutes < 1)
          return { error: "Interval must be at least 1 minute." };
        return { type: "interval", everyMinutes };
      }
      case "daily":
        return { type: "cron", expr: dailyCron(hh, mm) };
      case "weekly":
        return { type: "cron", expr: weeklyCron(hh, mm, weekday) };
      case "monthly":
        return { type: "cron", expr: monthlyCron(hh, mm, monthDay) };
      case "cron": {
        const expr = cronExpr.trim();
        if (!expr) return { error: "Enter a cron expression." };
        if (nextOccurrences({ type: "cron", expr }, 1) === null)
          return { error: `Invalid cron expression: "${expr}".` };
        return { type: "cron", expr };
      }
    }
  }

  // Upcoming fires of the draft schedule, shown under the fields so the user
  // can confirm the schedule means what they think before it ever fires.
  // Reads the same drafts buildTrigger does, so it tracks every edit.
  const cronInvalid = $derived(
    kind === "cron" &&
      cronExpr.trim() !== "" &&
      nextOccurrences({ type: "cron", expr: cronExpr.trim() }, 1) === null,
  );

  function currentAction(): AutomationAction {
    const planRefs = resolvePlanRefs();
    return {
      prompt: prompt.trim(),
      agentProvider,
      modelId,
      reasoningEffort,
      cwd: cwd.trim() || "~",
      useWorktree,
      planRefs: planRefs.length ? planRefs : undefined,
      workRefs: workRefs.length ? workRefs : undefined,
    };
  }

  function handleComposerRefs(
    nextPlanRefs: PlanReference[],
    nextWorkRefs: WorkReference[],
  ) {
    composerPlanRefs = nextPlanRefs;
    workRefs = nextWorkRefs;
  }

  /** Map the editor's plan tokens to storable refs, resolving each plan's source
   *  (file path preferred, content as fallback) from the plan store the first
   *  time we see it. Prunes sources for plans no longer referenced. */
  function resolvePlanRefs(): AutomationPlanRef[] {
    const refs = composerPlanRefs.map((r) => {
      const cached = planSources.get(r.planId);
      if (cached?.filePath || cached?.content) {
        return cached.title === r.title
          ? cached
          : { ...cached, title: r.title };
      }
      const plan = planStore.get(r.planId);
      const resolved: AutomationPlanRef = {
        planId: r.planId,
        title: r.title,
        filePath: plan?.filePath,
        content: plan?.filePath ? undefined : plan?.content,
      };
      planSources.set(r.planId, resolved);
      return resolved;
    });
    const live = new Set(composerPlanRefs.map((r) => r.planId));
    for (const id of planSources.keys())
      if (!live.has(id)) planSources.delete(id);
    return refs;
  }

  // ── Persistence (auto-save) ──
  let error = $state<string | null>(null);
  // Header save indicator — mirrors DocumentShell's auto-save status: a pulsing
  // dot + "Saving…" while a write is in flight, then a check + self-refreshing
  // "Last saved …" once it lands. `savedStatusNow` is ticked on an interval so
  // the relative timestamp stays current without an edit.
  let isSaving = $state(false);
  let lastSavedAt = $state<number | null>(null);
  let savedStatusNow = $state(Date.now());
  $effect(() => {
    if (lastSavedAt === null) return;
    const interval = setInterval(() => {
      savedStatusNow = Date.now();
    }, 10_000);
    return () => clearInterval(interval);
  });

  /** Materialize a brand-new automation from the current drafts. The create call
   *  captures the full draft, so callers that just triggered it can skip a follow-up
   *  update. Returns the id, or null on failure. */
  async function ensureCreated(): Promise<string | null> {
    if (current) return current.id;
    const trigger = buildTrigger();
    const created = await store.create(
      name.trim() || "Untitled automation",
      currentAction(),
      "error" in trigger ? { type: "manual" } : trigger,
      enabled,
    );
    savedSnapshot = created;
    currentId = created.id;
    return created.id;
  }

  async function persist(patch: {
    name?: string;
    enabled?: boolean;
    action?: Partial<AutomationAction>;
    trigger?: AutomationTrigger;
  }) {
    // A new automation with no name and no prompt is an untouched draft —
    // don't materialize it just because a field blurred or a select changed.
    // (Run now still creates via ensureCreated: running IS an intent to keep it.)
    if (!current && !name.trim() && !prompt.trim()) return;
    error = null;
    isSaving = true;
    try {
      // First edit on a new automation: the lazy create already saved every draft.
      if (!current) {
        await ensureCreated();
      } else {
        await store.update(current.id, patch);
        savedSnapshot = store.get(current.id) ?? savedSnapshot;
      }
      lastSavedAt = Date.now();
      savedStatusNow = lastSavedAt;
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally {
      isSaving = false;
    }
  }

  function commitName() {
    void persist({ name: name.trim() || "Untitled automation" });
  }
  function commitAction() {
    void persist({ action: currentAction() });
  }
  function commitTrigger() {
    const t = buildTrigger();
    if ("error" in t) {
      error = t.error;
      return;
    }
    void persist({ trigger: t });
  }

  function onAgentChange(id: AgentId) {
    agentProvider = id;
    modelId = null;
    commitAction();
  }

  function toggleEnabled() {
    enabled = !enabled;
    void persist({ enabled });
  }

  // ── Run now ──
  let running = $state(false);
  const isRunning = $derived(running || current?.lastRunStatus === "running");

  async function runNow() {
    const id = await ensureCreated();
    if (!id) return;
    running = true;
    try {
      await store.runNow(id);
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally {
      running = false;
    }
  }

  let cancelling = $state(false);
  async function cancelRun() {
    const id = current?.id;
    if (!id) return;
    cancelling = true;
    try {
      await store.cancel(id);
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally {
      cancelling = false;
    }
  }

  // ── Directory picker (Project) ──
  let pickerOpen = $state(false);
  function handlePickerSelect(dir: string) {
    cwd = dir;
    pickerOpen = false;
    commitAction();
  }

  function openRunSession(sessionId: string | null | undefined) {
    if (!sessionId) return;
    // Resume the spawned run as a session so the user can inspect what it did,
    // under the automation's SAVED provider/cwd (drafts may hold unsaved edits).
    void session.resumeSession({
      provider: current?.action.agentProvider ?? agentProvider,
      sessionId,
      slug: null,
      firstMessage: name || "Automation run",
      lastTimestamp: new Date().toISOString(),
      size: 0,
      cwd: current?.action.cwd ?? cwd,
      projectPath: "",
    });
    // Leave the builder: close the pane (editor) or the full-page list (pill).
    if (inline) onClose?.();
    else session.automationsOpen = false;
  }
</script>

{#snippet saveStatus()}
  <span
    class="inline-flex items-center gap-[0.3125rem] whitespace-nowrap text-[0.6875rem] text-(--solus-text-tertiary) select-none"
    aria-live="polite"
    role="status"
  >
    {#if isSaving}
      <span
        class="size-1.5 shrink-0 rounded-full bg-(--solus-accent) animate-pulse"
        aria-hidden="true"
      ></span>
      <span>Saving…</span>
    {:else if lastSavedAt !== null}
      <CheckIcon size={11} />
      <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
    {/if}
  </span>
{/snippet}

{#snippet runControls()}
  {#if isRunning}
    <button
      type="button"
      class={STOP_BTN}
      onclick={cancelRun}
      disabled={cancelling}
      aria-label="Stop run"
    >
      {#if cancelling}
        <CircleNotchIcon size={14} weight="bold" class="animate-spin" />
        <span>Stopping…</span>
      {:else}
        <StopIcon size={13} weight="fill" />
        <span>Stop</span>
      {/if}
    </button>
  {:else}
    <button type="button" class={RUN_BTN} onclick={runNow} aria-label="Run now">
      <PlayIcon size={13} weight="fill" />
      <span>Run now</span>
    </button>
  {/if}
{/snippet}

{#snippet formBody()}
  {#if error}
    <p
      class="text-xs text-[var(--solus-status-error,#e53e3e)] bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_10%,transparent)] px-3 py-2 rounded-lg"
      role="alert"
    >
      {error}
    </p>
  {/if}

  <div
    class="grid grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)] grid-rows-[minmax(0,1fr)] gap-8 items-stretch flex-1 min-h-0 @max-[56rem]:gap-6 @max-[46rem]:grid-cols-1 @max-[46rem]:grid-rows-[auto_minmax(0,1fr)] @max-[46rem]:gap-5"
  >
    <!-- ── Main: name + prompt ── -->
    <section id="overview" class="flex flex-col gap-3.5 min-w-0 h-full min-h-0">
      <Input
        class={TITLE_INPUT}
        type="text"
        bind:value={name}
        onblur={commitName}
        placeholder="Untitled automation"
        aria-label="Automation name"
        autocomplete="off"
      />
      <div class={PROMPT_FIELD}>
        <PromptEditor
          value={prompt}
          onValueChange={(md) => (prompt = md)}
          onRefsChange={handleComposerRefs}
          onBlur={commitAction}
          enterInsertsNewline
          pluginCommands={session.pluginCommands}
          provider={agentProvider}
          workingDirectory={cwd}
          onPlanRefClick={(planId) => session.openPlanModal(planId)}
          onWorkRefClick={(workId, title) =>
            session.openWorkModal(workId, title)}
          menuPlacement="down"
          placeholder="What should the agent do each run? Use @ for files, / for skills, # for plans, % for docs."
        />
      </div>
    </section>

    <!-- ── Sidebar ── -->
    <!-- Retarget the shared ghost-select hover to the brand accent wash within
           these cards (overrides Select.svelte's neutral hover via specificity). -->
    <aside
      class="flex flex-col gap-5 min-w-0 @max-[46rem]:order-first [&_.sel-ghost:hover]:bg-(--solus-accent-light)"
    >
      <!-- Status -->
      <section id="status" class={SECTION}>
        <h2 class={SECTION_TITLE}>Status</h2>

        <!-- Live state on the left, a switch to toggle it on the right. The card
             title already says "Status", so the row leads with the state itself. -->
        <div class="flex items-center justify-between gap-3">
          <span
            class="inline-flex items-center gap-2 text-[0.8125rem] font-normal {enabled
              ? 'text-(--solus-text-primary)'
              : 'text-(--solus-text-tertiary)'}"
          >
            <span
              class="size-2 shrink-0 rounded-full {enabled
                ? 'bg-[var(--solus-art-3,#5a9e6f)]'
                : 'border border-(--solus-text-tertiary)'}"
            ></span>
            {enabled ? "Active" : "Paused"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onclick={toggleEnabled}
            aria-label={enabled ? "Pause automation" : "Resume automation"}
            class="relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-6 pointer-coarse:w-11 {enabled
              ? 'bg-[var(--solus-art-3,#5a9e6f)]'
              : 'bg-(--solus-container-border)'}"
          >
            <span
              class="absolute left-0.5 top-1/2 size-3 -translate-y-1/2 rounded-full bg-white shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.25)] transition-transform duration-150 pointer-coarse:size-[1.125rem] {enabled
                ? 'translate-x-3 pointer-coarse:translate-x-5'
                : ''}"
            ></span>
          </button>
        </div>

        <!-- Next run + Last ran as quiet property rows -->
        <dl class="flex flex-col">
          <div class={ROW}>
            <dt class="text-xs text-(--solus-text-tertiary)">Next run</dt>
            <dd class={META_VALUE}>
              {#if enabled && current?.nextRunAt}
                {absoluteTime(current.nextRunAt, nowTick)}
              {:else if kind === "manual"}
                Manual only
              {:else}
                Not scheduled
              {/if}
            </dd>
          </div>
          <div class={ROW}>
            <dt class="text-xs text-(--solus-text-tertiary)">Last ran</dt>
            <dd class={META_VALUE}>
              {current?.lastRunAt
                ? absoluteTime(current.lastRunAt, nowTick)
                : "Never"}
            </dd>
          </div>
        </dl>
      </section>

      <!-- Details -->
      <section id="details" class={SECTION_DIVIDED}>
        <h2 class={SECTION_TITLE}>Details</h2>
        <dl class={META}>
          <div class={ROW}>
            <dt>Repeats</dt>
            <dd>
              <Select.Root
                type="single"
                value={kind}
                onValueChange={(v) => {
                  kind = v as BuilderTriggerKind;
                  commitTrigger();
                }}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Repeats">
                  {repeatOptions.find((o) => o.value === kind)?.label}
                </Select.Trigger>
                <Select.Content align="end" class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each repeatOptions as opt (opt.value)}
                    <Select.Item value={opt.value} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
            </dd>
          </div>

          {#if kind === "once"}
            <div class="flex pb-1.5">
              <DateTimePicker value={onceLocal} onChange={setOnceAt} />
            </div>
          {:else if kind === "interval"}
            <div class="flex items-center gap-1.5 flex-wrap pb-1.5">
              <span class={SUB_LABEL}>Every</span>
              <Input
                class="{FIELD} {FIELD_NUM} w-16 pointer-coarse:w-[4.5rem]"
                type="number"
                min="1"
                bind:value={intervalValue}
                onchange={commitTrigger}
                aria-label="Interval amount"
              />
              <Select.Root
                type="single"
                value={intervalUnit}
                onValueChange={(v) => {
                  intervalUnit = v as "minutes" | "hours" | "days";
                  commitTrigger();
                }}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Interval unit">
                  {intervalUnit}
                </Select.Trigger>
                <Select.Content class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each intervalUnitOptions as opt (opt.value)}
                    <Select.Item value={opt.value} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          {:else if kind === "daily"}
            <div class="flex items-center gap-1.5 flex-wrap pb-1.5">
              <span class={SUB_LABEL}>At</span>
              <Input
                type="time"
                value={timeStr}
                onchange={(event) => {
                  const value = event.currentTarget.value;
                  if (!value) return;
                  timeStr = value;
                  commitTrigger();
                }}
                class={TIME_FIELD}
                aria-label="Time"
              />
            </div>
          {:else if kind === "weekly"}
            <div class="flex items-center gap-1.5 flex-wrap pb-1.5">
              <Select.Root
                type="single"
                value={String(weekday)}
                onValueChange={(v) => {
                  weekday = Number(v);
                  commitTrigger();
                }}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Day of week">
                  {weekdayOptions.find((o) => o.value === weekday)?.label}
                </Select.Trigger>
                <Select.Content class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each weekdayOptions as opt (opt.value)}
                    <Select.Item value={String(opt.value)} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
              <span class={SUB_LABEL}>at</span>
              <Input
                type="time"
                value={timeStr}
                onchange={(event) => {
                  const value = event.currentTarget.value;
                  if (!value) return;
                  timeStr = value;
                  commitTrigger();
                }}
                class={TIME_FIELD}
                aria-label="Time"
              />
            </div>
          {:else if kind === "monthly"}
            <div class="flex items-center gap-1.5 flex-wrap pb-1.5">
              <span class={SUB_LABEL}>Day</span>
              <Input
                class="{FIELD} {FIELD_NUM} w-16 pointer-coarse:w-[4.5rem]"
                type="number"
                min="1"
                max="31"
                bind:value={monthDay}
                onchange={commitTrigger}
                aria-label="Day of month"
              />
              <span class={SUB_LABEL}>at</span>
              <Input
                type="time"
                value={timeStr}
                onchange={(event) => {
                  const value = event.currentTarget.value;
                  if (!value) return;
                  timeStr = value;
                  commitTrigger();
                }}
                class={TIME_FIELD}
                aria-label="Time"
              />
            </div>
          {:else if kind === "cron"}
            <div class="flex flex-col gap-1 pb-1.5">
              <Input
                class="{FIELD} w-full font-mono"
                type="text"
                bind:value={cronExpr}
                onchange={commitTrigger}
                placeholder="0 9 * * 1-5"
                aria-label="Cron expression"
                aria-invalid={cronInvalid}
                autocomplete="off"
              />
              {#if cronInvalid}
                <p
                  class="m-0 text-[0.6875rem] text-[var(--solus-status-error,#e53e3e)]"
                >
                  Invalid cron expression.
                </p>
              {/if}
            </div>
          {/if}

          <div class={ROW}>
            <dt>Project</dt>
            <dd>
              <button
                type="button"
                class="inline-flex items-center justify-end w-auto max-w-[11rem] gap-1 px-1.5 py-1 text-xs rounded-lg border-0 bg-transparent text-(--solus-text-primary) cursor-pointer transition-[background-color] duration-100 hover:bg-(--solus-accent-light) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:min-h-11 pointer-coarse:max-w-[14rem] pointer-coarse:px-2.5 pointer-coarse:py-2 pointer-coarse:text-[0.9375rem]"
                onclick={() => (pickerOpen = true)}
                title={cwd}
              >
                <span class="truncate">{projectName}</span>
              </button>
            </dd>
          </div>

          <div class={ROW}>
            <dt>Agent</dt>
            <dd>
              <Select.Root
                type="single"
                value={agentProvider}
                onValueChange={(v) => onAgentChange(v as AgentId)}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Agent">
                  {agentSelectOptions.find((o) => o.value === agentProvider)?.label}
                </Select.Trigger>
                <Select.Content align="end" class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each agentSelectOptions as opt (opt.value)}
                    <Select.Item value={opt.value} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
            </dd>
          </div>

          <div class={ROW}>
            <dt>Model</dt>
            <dd>
              <Select.Root
                type="single"
                value={effectiveModelId ?? ""}
                onValueChange={(v) => {
                  modelId = v;
                  commitAction();
                }}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Model">
                  {modelSelectOptions.find((o) => o.value === effectiveModelId)?.label}
                </Select.Trigger>
                <Select.Content align="end" class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each modelSelectOptions as opt (opt.value)}
                    <Select.Item value={opt.value ?? ""} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
            </dd>
          </div>

          <div class={ROW}>
            <dt>Reasoning</dt>
            <dd>
              <Select.Root
                type="single"
                value={reasoningEffort}
                onValueChange={(v) => {
                  reasoningEffort = v as ReasoningEffort;
                  commitAction();
                }}
              >
                <Select.Trigger class={GHOST_TRIGGER} aria-label="Reasoning">
                  {reasoningSelectOptions.find((o) => o.value === reasoningEffort)?.label}
                </Select.Trigger>
                <Select.Content align="end" class="z-[10002] overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
                  {#each reasoningSelectOptions as opt (opt.value)}
                    <Select.Item value={opt.value} label={opt.label} class="gap-2 rounded-md px-3 py-1.5 pr-8 text-[0.6875rem] text-(--solus-text-secondary) data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary)" />
                  {/each}
                </Select.Content>
              </Select.Root>
            </dd>
          </div>

          {#if inSession}
            <!-- Agent-created heartbeat automation: runs resume its chat thread
                 (full context) instead of spawning isolated background runs.
                 Worktree doesn't apply — the thread runs where it runs. -->
            <div class={ROW}>
              <dt>Runs in</dt>
              <dd>
                <span
                  class="{META_VALUE} inline-flex items-center gap-1.5"
                  title="Each run resumes the chat thread this automation was created in, with full conversation context"
                >
                  <ChatCircleDotsIcon size={13} class="shrink-0" />
                  Chat thread
                </span>
              </dd>
            </div>
          {:else}
            <div class={ROW}>
              <dt>Worktree</dt>
              <dd>
                <label
                  class="group inline-flex items-center cursor-pointer pointer-coarse:min-h-11 pointer-coarse:px-1.5"
                  title="Run each fire on an isolated git branch"
                >
                  <input
                    type="checkbox"
                    class="sr-only"
                    bind:checked={useWorktree}
                    onchange={commitAction}
                  />
                  <span
                    class="relative w-7 h-4 shrink-0 rounded-full bg-(--solus-container-border) transition-colors duration-150 group-has-[:checked]:bg-(--solus-accent) group-has-[:focus-visible]:outline-2 group-has-[:focus-visible]:outline-offset-2 group-has-[:focus-visible]:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:w-11 pointer-coarse:h-6"
                  >
                    <span
                      class="absolute left-0.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.25)] transition-transform duration-150 group-has-[:checked]:translate-x-3 pointer-coarse:w-[1.125rem] pointer-coarse:h-[1.125rem] pointer-coarse:group-has-[:checked]:translate-x-5"
                    ></span>
                  </span>
                </label>
              </dd>
            </div>
          {/if}
        </dl>
      </section>

      <!-- Previous runs -->
      <section id="previous-runs" class={SECTION_DIVIDED}>
        <h2 class={SECTION_TITLE}>Previous runs</h2>
        {#if runs.length === 0}
          <p class="text-xs text-(--solus-text-tertiary) leading-normal">
            No runs yet. Use Run now to test it.
          </p>
        {:else}
          <ul class="flex flex-col gap-1" role="list">
            {#each runs as r (r.id)}
              {@const meta = RUN_STATUS_META[r.status]}
              <li>
                <button
                  type="button"
                  class={RUN_ROW}
                  onclick={() => openRunSession(r.agentSessionId)}
                  disabled={!r.agentSessionId}
                >
                  <span
                    class="shrink-0 inline-flex {meta.tone === 'success'
                      ? 'text-[var(--solus-art-3,#5a9e6f)]'
                      : meta.tone === 'error'
                        ? 'text-[var(--solus-status-error,#e53e3e)]'
                        : meta.tone === 'cancelled'
                          ? 'text-(--solus-text-tertiary)'
                          : 'text-(--solus-accent)'}"
                  >
                    {#if meta.tone === "success"}
                      <CheckCircleIcon size={14} weight="fill" />
                    {:else if meta.tone === "error"}
                      <WarningCircleIcon size={14} weight="fill" />
                    {:else if meta.tone === "cancelled"}
                      <ProhibitIcon size={14} weight="bold" />
                    {:else}
                      <CircleNotchIcon size={14} class="animate-spin" />
                    {/if}
                  </span>
                  <span class="flex-1 min-w-0 flex flex-col gap-px">
                    <span class="text-xs text-(--solus-text-primary) truncate"
                      >{name || "Automation run"}</span
                    >
                    {#if r.status === "failed" && r.error}
                      <!-- Failed runs often have no session to open, so this line
                           is the only diagnostic the user gets — show it here. -->
                      <span
                        class="text-[0.6875rem] leading-snug text-[var(--solus-status-error,#e53e3e)] line-clamp-2"
                        title={r.error}>{r.error}</span
                      >
                    {:else if r.branch}
                      <span
                        class="inline-flex items-center gap-1 text-[0.6875rem] text-(--solus-text-tertiary)"
                        title="Changes from this run live on branch {r.branch}"
                      >
                        <GitBranchIcon size={10} class="shrink-0" />
                        <span class="truncate">{r.branch}</span>
                      </span>
                    {:else}
                      <span
                        class="text-[0.6875rem] text-(--solus-text-tertiary)"
                        >{projectName}</span
                      >
                    {/if}
                  </span>
                  <span
                    class="shrink-0 text-[0.6875rem] text-(--solus-text-tertiary)"
                    >{runDate(r.startedAt)} · {runDuration(r) ||
                      relativeTime(r.startedAt)}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </aside>
  </div>
{/snippet}

{#if inline}
  <!-- ── Side-panel pane: fixed chrome header + scrolling form ── -->
  <div class="flex h-full min-h-0 flex-col {SIDEBAR_PANEL_BG}">
    <header
      class="flex h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center justify-between gap-3 border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
    >
      <nav
        class="flex items-center gap-1.5 min-w-0 text-[0.8125rem]"
        aria-label="Breadcrumb"
      >
        <button type="button" class={CRUMB_LINK} onclick={paneBackToList}
          >Automations</button
        >
        <CaretRightIcon
          size={12}
          class="text-(--solus-text-tertiary) opacity-60 shrink-0"
        />
        <span
          class="truncate font-[550] text-(--solus-text-primary)"
          aria-current="page">{name || "Untitled automation"}</span
        >
        {#if isSaving || lastSavedAt !== null}
          <span
            class="shrink-0 pl-1.5 border-l border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
          >
            {@render saveStatus()}
          </span>
        {/if}
      </nav>
      <div class="flex shrink-0 items-center gap-1">
        {@render runControls()}
        {#if onOpenInSplit}
          <button
            type="button"
            class={PANE_ICON_BTN}
            onclick={onOpenInSplit}
            aria-label={slot === "secondary" ? "Focus" : "Open in split"}
            title={slot === "secondary" ? "Focus" : "Open in split"}
          >
            {#if slot === "secondary"}
              <ArrowsOutSimpleIcon size={15} />
            {:else}
              <ArrowSquareOutIcon size={15} />
            {/if}
          </button>
        {/if}
        <button
          type="button"
          class={PANE_ICON_BTN}
          onclick={onClose}
          aria-label="Close"
          title="Close"
        >
          <XIcon size={15} weight="bold" />
        </button>
      </div>
    </header>
    <div
      class="flex flex-1 min-h-0 flex-col overflow-y-auto pt-4 px-5 pb-8 [scrollbar-width:thin] overscroll-y-contain @max-[34rem]:px-3.5"
    >
      <article
        class="max-w-[92rem] w-full mx-auto flex flex-1 min-h-0 flex-col gap-5"
      >
        {@render formBody()}
      </article>
    </div>
  </div>
{:else}
  <!-- ── Full-page (pill / overlay): breadcrumb header scrolls with the form ── -->
  <div
    class="flex flex-1 min-h-0 flex-col overflow-y-auto pt-4 px-5 pb-8 [scrollbar-width:thin] overscroll-y-contain @max-[34rem]:px-3.5"
  >
    <article
      class="max-w-[92rem] w-full mx-auto flex flex-1 min-h-0 flex-col gap-5 @max-[46rem]:flex-none"
    >
      <header class="flex items-center justify-between gap-4">
        <nav
          class="flex items-center gap-1.5 min-w-0 text-[0.8125rem]"
          aria-label="Breadcrumb"
        >
          <button type="button" class={CRUMB_LINK} onclick={onDone}
            >Automations</button
          >
          <CaretRightIcon
            size={12}
            class="text-(--solus-text-tertiary) opacity-60 shrink-0"
          />
          <span
            class="truncate font-[550] text-(--solus-text-primary)"
            aria-current="page">{name || "Untitled automation"}</span
          >
          {#if isSaving || lastSavedAt !== null}
            <span
              class="shrink-0 pl-1.5 border-l border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
            >
              {@render saveStatus()}
            </span>
          {/if}
        </nav>
        {@render runControls()}
      </header>
      {@render formBody()}
    </article>
  </div>
{/if}

<DirectoryPicker
  bind:open={pickerOpen}
  onClose={() => (pickerOpen = false)}
  onSelect={handlePickerSelect}
  initialPath={cwd}
/>
