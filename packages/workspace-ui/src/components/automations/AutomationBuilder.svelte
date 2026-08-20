<script lang="ts">
  import {
    Play as PlayIcon,
    Square as StopIcon,
    LoaderCircle as CircleNotchIcon,
    Check as CheckIcon,
    MessageCircleMore as ChatCircleDotsIcon,
    Pen as PencilSimpleIcon,
  } from "@lucide/svelte";
  import type {
    Automation,
    AutomationAction,
    AutomationPlanRef,
    AutomationRun,
    AutomationTrigger,
    AgentId,
    PlanReference,
    ReasoningEffort,
    WorkReference,
  } from "@solus/contracts/types";
  import { REASONING_EFFORT_LABELS } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getAgentContext,
    getPlanStore,
    hostCapabilitiesStore,
    serversStore,
  } from "../../contexts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { agentLabel } from "../../lib/agentAvailability";
  import * as Breadcrumb from "../ui/breadcrumb";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import {
    absoluteTime,
    countdown,
    dayLabel,
    relativeTime,
    runDuration,
    runHealth,
    automationRunCwd,
  } from "./lib/automation-format";
  import { ScheduleDraft } from "./lib/schedule-draft.svelte";
  import { ROW, EYEBROW, VALUE, MONO_VALUE, VALUE_TRIGGER } from "./lib/rail-styles";
  import AutomationInstructions from "./AutomationInstructions.svelte";
  import AutomationRailSelect from "./AutomationRailSelect.svelte";
  import AutomationRunHistory from "./AutomationRunHistory.svelte";
  import AutomationScheduleFields from "./AutomationScheduleFields.svelte";
  import { formatSavedAgo } from "../document-shell/saveStatus";
  import { automationCapableHosts } from "@solus/client-core/host-capabilities";

  import { tick, untrack } from "svelte";

  interface Props {
    automation: Automation | null;
    onDone: () => void;
    /** Rendered inside a pane: the breadcrumb returns to the automations list
     *  and Esc closes the slot, instead of the full-page host owning both. */
    inline?: boolean;
    onClose?: () => void;
    /** Host of the session surface that opened a new builder. */
    originServerId?: string;
  }
  let {
    automation,
    onDone,
    inline = false,
    onClose,
    originServerId,
  }: Props = $props();

  // ── Page shape ──
  // One page, two voices: a reading column of author-written instructions set
  // like prose, and a rail of machine facts set like data. Whitespace and the
  // single card edge do the dividing — no vertical rules, no card around the
  // steps. Below 65rem the rail unstacks under the prose as a row of blocks.
  // `justify-center` centers the two columns horizontally while they're a row;
  // once stacked it would center them *vertically*, so it's reset to start.
  const BODY =
    "flex min-h-0 flex-1 items-start justify-center gap-16 overflow-y-auto px-14 pt-12 pb-18 overscroll-y-contain " +
    "[.is-laptop-display_&]:gap-10 [.is-laptop-display_&]:px-9 [.is-laptop-display_&]:pt-8 [.is-laptop-display_&]:pb-12 " +
    "pointer-coarse:gap-7.5 pointer-coarse:px-5 pointer-coarse:pt-5.5 pointer-coarse:pb-9 " +
    "@max-[65rem]:flex-col @max-[65rem]:items-stretch @max-[65rem]:justify-start @max-[65rem]:gap-7.5 @max-[65rem]:px-7 @max-[65rem]:pt-7 @max-[65rem]:pb-11 " +
    "@max-[43.75rem]:px-5 @max-[43.75rem]:pt-5.5 @max-[43.75rem]:pb-9";
  const MAIN_COLUMN =
    "flex w-full min-w-0 max-w-[53.75rem] flex-1 flex-col @max-[65rem]:max-w-none @max-[65rem]:flex-none";
  const RAIL_BLOCK =
    "flex min-w-0 flex-col gap-3 [.is-laptop-display_&]:gap-2.5 @max-[65rem]:min-w-[14.375rem] @max-[65rem]:flex-1 @max-[65rem]:basis-[15.625rem]";
  // The stat strip reads a value under its label, so it takes the same two rungs
  // as the rail: EYEBROW for the label, the chrome rung for the value.
  const STAT_VALUE = "text-workspace-chrome font-medium";
  // Pill actions in the title row. Both sit at 2.0625rem so they read as one
  // pair; only "Run now" carries fill.
  const PILL =
    "h-[2.0625rem] shrink-0 rounded-full text-workspace-chrome [.is-laptop-display_&]:h-[1.875rem]";
  // Sidebar background — also used by the inline pane container. Kept a hair
  // warmer than the page so the pane reads as its own surface.
  const SIDEBAR_PANEL_BG =
    "bg-[color:color-mix(in_srgb,var(--solus-container-bg)_90%,color-mix(in_srgb,var(--solus-input-pill-bg)_70%,var(--solus-surface-primary))_10%)]";
  const CRUMB_LINK =
    "border-0 bg-transparent text-muted-foreground cursor-pointer px-1 py-0.5 rounded-md " +
    "transition-[color,background-color] duration-100 hover:text-foreground hover:bg-muted " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] " +
    "pointer-coarse:min-h-10 pointer-coarse:inline-flex pointer-coarse:items-center pointer-coarse:px-2";
  // The title, editable in place: same 2.125rem type as the h1 it replaces, so
  // entering edit mode doesn't reflow the page.
  const TITLE_INPUT =
    "h-auto w-full -ml-1.5 rounded-lg border-0 bg-transparent px-1.5 py-0 text-2xl max-md:text-2xl font-medium leading-[1.1] " +
    "text-foreground shadow-none [outline:0.0625rem_solid_transparent] transition-[outline-color,background-color] duration-120 " +
    "placeholder:text-muted-foreground hover:bg-muted focus-visible:bg-transparent focus-visible:ring-0 " +
    "focus-visible:[outline-color:color-mix(in_srgb,var(--solus-accent)_55%,transparent)]";
  // Wraps the prompt editor as one tall field at the prose column's own measure,
  // so the writing view and the reading view sit on the same grid.
  const PROMPT_FIELD =
    "-ml-2 flex w-full min-h-[16rem] flex-col rounded-lg bg-transparent px-2 [outline:0.0625rem_solid_transparent] transition-[outline-color,background-color] duration-120 " +
    "[&_[data-testid=message-input]]:flex [&_[data-testid=message-input]]:flex-1 [&_[data-testid=message-input]]:min-h-0 " +
    "[&_.cm-editor]:flex-1 [&_.cm-editor]:min-h-0 [&_.cm-scroller]:max-h-none! [&_.cm-content]:min-h-full [&_.cm-content]:![font-weight:400] " +
    "[&_.cm-content]:![font-size:var(--text-sm)] [&_.cm-content]:![line-height:1.75]";

  const session = getWorkspaceContext();
  const store = session.automationsStore;
  // With no owning automation and no origin, the picker starts on the
  // new-work default host; the menu itself still lists every connected host.
  const defaultServerId =
    serverConnections.defaultServerId() ??
    serverConnections.connectedServerIds()[0];
  let selectedServerId = $state(
    untrack(
      () =>
        store.hostFor(automation?.id) ??
        (originServerId ? serverConnections.resolveId(originServerId) : null) ??
        defaultServerId ??
        "",
    ),
  );
  const connectedHosts = $derived.by(() => {
    // The host directory is reactive; the connection registry supplies only
    // hosts the app already has open and never creates a socket for this menu.
    void serversStore.servers;
    return serverConnections.connectedServerIds().map((serverId) => ({
      serverId,
      label:
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        serverId,
    }));
  });
  const hostOptions = $derived(
    automationCapableHosts(
      connectedHosts,
      (serverId) => hostCapabilitiesStore.for(serverId),
    ).map((host) => ({ value: host.serverId, label: host.label })),
  );
  const selectedHostLabel = $derived(
    hostOptions.find((option) => option.value === selectedServerId)?.label ??
      "Selected host",
  );
  const selectedHostSupportsAutomations = $derived(
    hostCapabilitiesStore.supports(selectedServerId, "automations"),
  );
  const selectedHostApi = $derived(
    selectedServerId && selectedHostSupportsAutomations
      ? serverConnections.apiFor(selectedServerId)
      : null,
  );

  $effect(() => {
    for (const host of connectedHosts) void hostCapabilitiesStore.load(host.serverId);
  });

  $effect(() => {
    if (connectedHosts.some((host) => hostCapabilitiesStore.for(host.serverId) === undefined)) return;
    if (!hostOptions.some((option) => option.value === selectedServerId)) {
      selectedServerId = hostOptions[0]?.value ?? "";
    }
  });

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

  // Read by default: the instructions are prose to be read, not a form to be
  // filled. A brand-new automation has nothing to read, so it opens writing.
  let isEditing = $state(untrack(() => automation === null));
  let titleEl = $state<HTMLInputElement | null>(null);

  // Mirrors the stored trigger; the rail's "Repeats" row drives which of its
  // fields are live, and `build()` compiles them back to a trigger.
  const schedule = new ScheduleDraft(initial?.trigger);

  // ── Select option lists ──
  const models = $derived(agentContext.metadata[agentProvider]?.models ?? []);
  const agentSelectOptions = $derived(
    agentOptions.length > 0
      ? agentOptions.map((a) => ({
          value: a.id,
          label: agentLabel(a.id, agentContext.metadata),
        }))
      : [{ value: "claude-code", label: "Claude" }],
  );
  const modelSelectOptions = $derived(
    models.map((m) => ({ value: m.id, label: m.label })),
  );
  // `modelId: null` means "the provider's default model" — display it as the
  // first model without writing it back. Pinning + saving here used to fire on
  // mount, creating a ghost "Untitled automation" the moment the New view opened.
  const effectiveModelId = $derived(modelId ?? models[0]?.id ?? null);
  const reasoningSelectOptions = REASONING_OPTIONS.map((r) => ({
    value: r,
    label: REASONING_EFFORT_LABELS[r] ?? r,
  }));
  const projectName = $derived(cwd.split("/").filter(Boolean).pop() ?? cwd);
  // In-session ("heartbeat") automations run inside the chat thread they were
  // created in. The builder can't create them (agent-only), but it must show
  // what they are — and hide the worktree toggle, which is ignored for them.
  const inSession = $derived(!!current?.action.sessionId);

  // Run history for the live automation. Keyed on the id (not `current`, which
  // is replaced on every save/push) so history only reloads when the id changes;
  // subsequent run updates arrive through `automation.changed`.
  const runsKey = $derived(current?.id ?? null);
  const runs = $derived(runsKey ? (store.runs.get(runsKey) ?? []) : []);
  let isRunHistoryExpanded = $state(false);
  $effect(() => {
    isRunHistoryExpanded = false;
    if (runsKey) void store.loadRuns(runsKey);
  });

  // Minute-ish ticker so "Next run" / "Last ran" stay truthful while the
  // detail sits open (a fired schedule also pushes a fresh nextRunAt).
  let nowTick = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowTick = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // ── The strip of machine facts under the title ──
  const health = $derived(runHealth(runs));
  const lastRun = $derived(runs[0] ?? null);

  const nextRunLabel = $derived(
    enabled && current?.nextRunAt
      ? absoluteTime(current.nextRunAt, nowTick)
      : schedule.kind === "manual"
        ? "Manual only"
        : "Not scheduled",
  );

  /** The "· next run in 4h 12m" tail on the state line. Times are human here,
   *  never ISO — the exact instant is one line down in the Next stat. */
  const scheduleNote = $derived.by(() => {
    if (!enabled) return "";
    if (schedule.kind === "manual") return "runs on demand";
    const left = countdown(current?.nextRunAt, nowTick);
    return left ? `next run in ${left}` : "";
  });

  const lastRunLabel = $derived.by(() => {
    if (!current?.lastRunAt) return "Never run";
    const day = dayLabel(current.lastRunAt, nowTick);
    const status = lastRun?.status ?? current.lastRunStatus;
    const duration = lastRun ? runDuration(lastRun) : "";
    if (status === "running") return `${day} · still running`;
    if (status === "cancelled") return `${day} · cancelled`;
    if (status === "dispatched") return `${day} · sent to chat`;
    if (status === "failed") return duration ? `${day} · failed after ${duration}` : `${day} · failed`;
    return duration ? `${day} · finished in ${duration}` : day;
  });

  const metaBits = $derived(
    [
      current?.updatedAt ? `Edited ${relativeTime(current.updatedAt, nowTick)}` : "",
      inSession ? "Runs in chat thread" : useWorktree ? "Isolated worktree" : "Runs in place",
      `${REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort} reasoning`,
    ].filter(Boolean),
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
    // Only the prompt editor reports these tokens, and it only exists in writing
    // mode. In reading mode a rail change (model, worktree, project) must not be
    // read as "the prompt references no plans" and wipe the saved refs.
    if (!isEditing) return [...planSources.values()];
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
  // Header save indicator — mirrors DocumentShell's auto-save status: a spinner
  // + "Saving…" while a write is in flight, then a check + self-refreshing
  // "Last saved …" once it lands. `savedStatusNow` is ticked on an interval so
  // the relative timestamp stays current without an edit.
  let isSaving = $state(false);
  // Seeded from the automation's own `updatedAt`, so an automation that already
  // exists — a template the launchpad just created, a row reopened from the list
  // — reads "Last saved …" the moment it opens. There is no Save button here, so
  // an empty header was the only cue, and it said nothing at all.
  let lastSavedAt = $state<number | null>(
    untrack(() => {
      const saved = automation ? Date.parse(automation.updatedAt) : NaN;
      return Number.isFinite(saved) ? saved : null;
    }),
  );
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
    if (!selectedServerId || !selectedHostSupportsAutomations) {
      throw new Error("No connected host supports automations");
    }
    const trigger = schedule.build();
    const created = await store.create(
      selectedServerId,
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
      toasts.error("Couldn't save automation", { description: String(e?.message ?? e) });
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
    const t = schedule.build();
    if ("error" in t) {
      toasts.error("Couldn't schedule automation", { description: t.error });
      return;
    }
    void persist({ trigger: t });
  }

  function onAgentChange(id: AgentId) {
    agentProvider = id;
    modelId = null;
    commitAction();
  }

  function setEnabled(next: boolean) {
    enabled = next;
    void persist({ enabled });
  }

  function beginEdit() {
    isEditing = true;
    // Land focus where writing starts — the title, with the prompt editor one
    // Tab away.
    void tick().then(() => titleEl?.focus());
  }

  /** Leave writing mode. Field blur already auto-saves, so only commit what the
   *  click-through actually left dirty. */
  function endEdit() {
    // Commit before leaving writing mode: `currentAction()` reads the prompt
    // editor's live plan tokens, which are only trustworthy while it's mounted.
    if (name.trim() !== (current?.name ?? "")) commitName();
    if (prompt.trim() !== (current?.action.prompt ?? "")) commitAction();
    isEditing = false;
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
      toasts.error("Couldn't run automation", { description: String(e?.message ?? e) });
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
      toasts.error("Couldn't stop automation", { description: String(e?.message ?? e) });
    } finally {
      cancelling = false;
    }
  }

  // ── Directory picker (Project) ──
  let pickerOpen = $state(false);
  let pickerTriggerEl: HTMLButtonElement | null = $state(null);

  function closePicker() {
    pickerOpen = false;
    requestAnimationFrame(() => pickerTriggerEl?.focus());
  }

  function handlePickerSelect(dir: string) {
    cwd = dir;
    closePicker();
    commitAction();
  }

  function openRunSession(run: AutomationRun) {
    if (!run.agentSessionId) return;
    const automationCwd = current?.action.cwd ?? cwd;
    // Resume the spawned run as a session so the user can inspect what it did,
    // under the exact directory used by that run (drafts may hold unsaved edits).
    void session.resumeSession({
      provider: current?.action.agentProvider ?? agentProvider,
      serverId: selectedServerId,
      sessionId: run.agentSessionId,
      slug: null,
      firstMessage: name || "Automation run",
      lastTimestamp: new Date().toISOString(),
      size: 0,
      cwd: automationRunCwd(run, automationCwd, session.staticInfo?.homePath),
      projectPath: "",
    });
    // Leave the detail: close the pane (editor) or the full-page list (pill).
    if (inline) onClose?.();
    else session.router.close("automations");
  }
</script>

{#snippet saveStatus()}
  <span
    class="inline-flex shrink-0 items-center gap-[0.3125rem] text-xs whitespace-nowrap text-muted-foreground select-none"
    aria-live="polite"
    role="status"
  >
    {#if isSaving}
      <CircleNotchIcon size={11} class="animate-spin" aria-hidden="true" />
      <span>Saving…</span>
    {:else if lastSavedAt !== null}
      <CheckIcon size={11} />
      <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
    {/if}
  </span>
{/snippet}

<!-- ── Chrome: breadcrumb back to the list, plus the save indicator. In a pane
     the close / open-in-split live in the floating PaneChrome cluster, which the
     right inset reserves room for. -->
{#snippet chromeBar()}
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h) shrink-0 items-center justify-between gap-3 border-b border-border/45 pr-[max(0.875rem,var(--solus-pane-chrome-inset,0px))] pl-[max(1.25rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <Breadcrumb.Root class="min-w-0 flex-1 overflow-hidden">
      <Breadcrumb.List class="min-w-0 flex-nowrap gap-[0.4375rem] text-workspace-chrome">
        <Breadcrumb.Item>
          <Breadcrumb.Link class={CRUMB_LINK}>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                onclick={inline ? paneBackToList : onDone}>Automations</button
              >
            {/snippet}
          </Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator class="text-muted-foreground/45">/</Breadcrumb.Separator>
        <Breadcrumb.Item class="min-w-0">
          <Breadcrumb.Page
            class="truncate font-medium text-[color:color-mix(in_oklab,var(--foreground)_80%,var(--muted-foreground))]"
            >{name || "Untitled automation"}</Breadcrumb.Page
          >
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>
    {@render saveStatus()}
  </div>
{/snippet}

<!-- ── State line + title + the two actions ── -->
{#snippet titleBlock()}
  <div
    class="flex items-start justify-between gap-7 @max-[43.75rem]:flex-col @max-[43.75rem]:items-start @max-[43.75rem]:gap-3.5"
  >
    <div class="flex min-w-0 flex-1 flex-col gap-2.5">
      <div class="flex items-center gap-2">
        <span
          class="text-xs font-normal uppercase {enabled
 ? 'text-[color:color-mix(in_oklab,var(--chart-3)_72%,var(--foreground))]'
 : 'text-muted-foreground'}">{enabled ? "Active" : "Paused"}</span
        >
        {#if scheduleNote}
          <span class="truncate text-xs text-muted-foreground"
            >· {scheduleNote}</span
          >
        {/if}
      </div>
      {#if isEditing}
        <Input
          bind:ref={titleEl}
          class={TITLE_INPUT}
          type="text"
          bind:value={name}
          onblur={commitName}
          placeholder="Untitled automation"
          aria-label="Automation name"
          autocomplete="off"
        />
      {:else}
        <h1
          class="m-0 text-2xl font-medium leading-[1.1] text-foreground"
        >
          {name || "Untitled automation"}
        </h1>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-1.5 pt-4 @max-[43.75rem]:pt-0">
      {#if isEditing}
        <Button
          variant="outline"
          class="{PILL} gap-1.5 border-border/85 bg-transparent px-3 font-medium text-[color:color-mix(in_oklab,var(--foreground)_85%,var(--muted-foreground))] [.is-laptop-display_&]:px-2.5 dark:bg-transparent"
          onclick={endEdit}
        >
          <CheckIcon size={12} weight="bold" />
          Done
        </Button>
      {:else}
        <Button
          variant="outline"
          class="{PILL} gap-1.5 border-border/85 bg-transparent px-3 font-medium text-[color:color-mix(in_oklab,var(--foreground)_85%,var(--muted-foreground))] [.is-laptop-display_&]:px-2.5 dark:bg-transparent"
          onclick={beginEdit}
        >
          <PencilSimpleIcon size={12} />
          Edit
        </Button>
      {/if}

      {#if isRunning}
        <Button
          variant="destructive"
          class="{PILL} gap-1.5 px-3.5 font-medium [.is-laptop-display_&]:px-2.5"
          onclick={cancelRun}
          disabled={cancelling}
          aria-label="Stop run"
        >
          {#if cancelling}
            <CircleNotchIcon size={12} weight="bold" class="animate-spin" />
            Stopping…
          {:else}
            <StopIcon size={11} weight="fill" />
            Stop
          {/if}
        </Button>
      {:else}
        <Button
          class="{PILL} gap-[0.4375rem] pr-[0.9375rem] pl-[0.8125rem] font-medium hover:bg-[color:color-mix(in_oklab,var(--primary)_89%,black)] [.is-laptop-display_&]:pr-[0.6875rem] [.is-laptop-display_&]:pl-[0.625rem]"
          onclick={runNow}
          aria-label="Run now"
        >
          <PlayIcon size={11} weight="fill" />
          Run now
        </Button>
      {/if}
    </div>
  </div>
{/snippet}

<!-- ── Next / Last / Health: the three facts worth reading before the prose ── -->
{#snippet statStrip()}
  <div
    class="mt-6 grid grid-cols-[auto_auto_1fr] items-center gap-x-10 gap-y-3.5 rounded-2xl bg-muted/60 px-4.5 py-4 [.is-laptop-display_&]:mt-5 [.is-laptop-display_&]:gap-x-8 [.is-laptop-display_&]:py-3.5 @max-[43.75rem]:grid-cols-1 @max-[43.75rem]:gap-4"
  >
    <div class="flex min-w-0 flex-col gap-1">
      <span class={EYEBROW}>Next</span>
      <span class={STAT_VALUE}>{nextRunLabel}</span>
    </div>
    <div class="flex min-w-0 flex-col gap-1">
      <span class={EYEBROW}>Last</span>
      <span class={STAT_VALUE}>{lastRunLabel}</span>
    </div>
    {#if health.total > 0}
      <div
        class="flex min-w-0 flex-col gap-1.5 justify-self-end @max-[43.75rem]:justify-self-start"
      >
        <span class={EYEBROW}>Health</span>
        <div class="flex items-center gap-2.5">
          <div class="flex h-3.5 w-26 items-end gap-[0.15625rem]">
            {#each health.bars as bar (bar.id)}
              <span
                class="min-w-0 flex-1 rounded-[0.09375rem] {bar.failed
 ? 'bg-[var(--solus-status-error,#e53e3e)]'
 : bar.latest
 ? 'bg-chart-3/80'
 : 'bg-chart-3/38'}"
                style="height: {bar.heightPct}%"
              ></span>
            {/each}
          </div>
          <span class="text-xs whitespace-nowrap text-muted-foreground">
            {health.clean} of {health.total} clean
          </span>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<!-- ── The reading column: what the agent is told, every run ── -->
{#snippet instructionsBlock()}
  <div class="mt-8.5 flex flex-col gap-4.5 [.is-laptop-display_&]:mt-7 [.is-laptop-display_&]:gap-4">
    <div class="flex items-baseline gap-2.5">
      <span class={EYEBROW}>Instructions</span>
      <span class="text-xs text-muted-foreground/80"
        >given to the agent on every run</span
      >
    </div>

    {#if isEditing}
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
          onPrRefClick={(number, title) =>
            void session.enterPrReview(number, title, {
              ctx: session.ctxForDirectory(cwd),
            })}
          menuPlacement="down"
          placeholder="What should the agent do each run? Use @ for files, / for skills, # for plans, % for docs, ! for PRs."
        />
      </div>
    {:else if prompt.trim()}
      <AutomationInstructions markdown={prompt} />
    {:else}
      <button
        type="button"
        class="-ml-1.5 cursor-pointer self-start rounded-lg border-0 bg-transparent px-1.5 py-1 text-workspace-chrome text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        onclick={beginEdit}>Write what the agent should do each run…</button
      >
    {/if}

    <div
      class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/88"
    >
      {#each metaBits as bit, i (i)}
        {#if i > 0}<span class="opacity-40" aria-hidden="true">·</span>{/if}
        <span>{bit}</span>
      {/each}
    </div>
  </div>
{/snippet}

<!-- ── The rail: machine facts, set like data ── -->
{#snippet railCard()}
  <div
    class="flex flex-col gap-6.5 rounded-2xl border border-border/55 bg-card p-5 [.is-laptop-display_&]:gap-5 [.is-laptop-display_&]:p-4 @max-[65rem]:flex-row @max-[65rem]:flex-wrap @max-[65rem]:gap-x-10 @max-[65rem]:gap-y-6.5"
  >
    <!-- Schedule -->
    <div class={RAIL_BLOCK}>
      <AutomationScheduleFields
        {schedule}
        {enabled}
        onEnabledChange={setEnabled}
        onCommit={commitTrigger}
      />
    </div>

    <!-- Setup -->
    <div class={RAIL_BLOCK}>
      <span class={EYEBROW}>Setup</span>
      <div class="flex flex-col">
        <div class={ROW}>
          <span class="shrink-0 text-muted-foreground">Host</span>
          {#if current}
            <span class={VALUE}>{selectedHostLabel}</span>
          {:else}
            <AutomationRailSelect
              label="Automation host"
              value={selectedServerId}
              options={hostOptions}
              onSelect={(serverId) => {
                selectedServerId = serverId;
                pickerOpen = false;
              }}
            />
          {/if}
        </div>

        <div class={ROW}>
          <span class="shrink-0 text-muted-foreground">Project</span>
          <!-- Same chip as the menu-backed values, minus the caret: this one
               opens the directory picker, and a caret would promise a menu. -->
          <button
            bind:this={pickerTriggerEl}
            type="button"
            disabled={!selectedHostApi}
            class={VALUE_TRIGGER}
            onclick={() => (pickerOpen = true)}
            title={cwd}
          >
            <span class={MONO_VALUE}>{projectName}</span>
          </button>
        </div>

        <div class={ROW}>
          <span class="shrink-0 text-muted-foreground">Agent</span>
          <AutomationRailSelect
            label="Agent"
            value={agentProvider}
            options={agentSelectOptions}
            onSelect={onAgentChange}
            menuClass="w-[200px]"
          />
        </div>

        <div class={ROW}>
          <span class="shrink-0 text-muted-foreground">Model</span>
          <AutomationRailSelect
            label="Model"
            value={effectiveModelId ?? ""}
            options={modelSelectOptions}
            onSelect={(v) => {
              modelId = v;
              commitAction();
            }}
            menuClass="w-[216px]"
          />
        </div>

        <div class={ROW}>
          <span class="shrink-0 text-muted-foreground">Reasoning</span>
          <AutomationRailSelect
            label="Reasoning"
            value={reasoningEffort}
            options={reasoningSelectOptions}
            onSelect={(v) => {
              reasoningEffort = v;
              commitAction();
            }}
          />
        </div>

        {#if inSession}
          <!-- Agent-created heartbeat automation: runs resume its chat thread
               (full context) instead of spawning isolated background runs.
               Worktree doesn't apply — the thread runs where it runs. -->
          <div class={ROW}>
            <span class="shrink-0 text-muted-foreground">Runs in</span>
            <span
              class="{VALUE} inline-flex items-center gap-1.5"
              title="Each run resumes the chat thread this automation was created in, with full conversation context"
            >
              <ChatCircleDotsIcon size={13} class="shrink-0" />
              Chat thread
            </span>
          </div>
        {:else}
          <div class={ROW}>
            <span class="shrink-0 text-muted-foreground">Worktree</span>
            <Switch
              checked={useWorktree}
              onCheckedChange={(v) => {
                useWorktree = v;
                commitAction();
              }}
              size="default"
              class="[.is-laptop-display_&]:h-[14px] [.is-laptop-display_&]:w-6 [.is-laptop-display_&]:[&_[data-slot=switch-thumb]]:size-3"
              aria-label="Run each fire on an isolated git branch"
              title="Run each fire on an isolated git branch"
            />
          </div>
        {/if}
      </div>
    </div>

    <!-- History -->
    <div class={RAIL_BLOCK}>
      <AutomationRunHistory
        {runs}
        expanded={isRunHistoryExpanded}
        onToggle={() => (isRunHistoryExpanded = !isRunHistoryExpanded)}
        onOpen={openRunSession}
      />
    </div>
  </div>
{/snippet}

<!-- The detail view is a reading surface, so it pins the readable chrome rung
     rather than inheriting the automations list's compact one: the same builder
     must not change size because pill mode renders it inside that list. -->
<div
  class="@container flex min-h-0 flex-1 flex-col text-workspace-chrome {inline
 ? `h-full ${SIDEBAR_PANEL_BG}`
 : ''}"
>
  {@render chromeBar()}
  <div class={BODY}>
    <main class={MAIN_COLUMN}>
      {@render titleBlock()}
      {@render statStrip()}
      {@render instructionsBlock()}
    </main>
    <aside class="w-[21.25rem] shrink-0 [.is-laptop-display_&]:w-[19rem] @max-[65rem]:w-auto">
      {@render railCard()}
    </aside>
  </div>
</div>

{#if selectedHostApi}
<DirectoryPicker
  bind:open={pickerOpen}
  onClose={closePicker}
  onSelect={handlePickerSelect}
  initialPath={cwd}
  title="Choose automation project"
  actionLabel="Use project"
  api={selectedHostApi}
  hostLabel={selectedHostLabel}
  serverId={selectedServerId}
/>
{/if}
