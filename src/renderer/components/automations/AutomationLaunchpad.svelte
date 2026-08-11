<script lang="ts">
  import {
    PencilSimpleIcon,
    ClockIcon,
    PlayIcon,
    ArrowRightIcon,
    CheckIcon,
    CircleNotchIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { serverConnections } from "@client-core/server-connections";
  import { resolveSessionMetaRef } from "@client-core/session-meta";
  import { folderLabel, triggerSummary } from "./lib/automation-format";
  import {
    AUTOMATION_TEMPLATES,
    draftAutomationPrompt,
    type AutomationTemplate,
  } from "./lib/automation-templates";

  /** Two ways into a first automation, for a workspace that has none and for one
   *  that has plenty: describe it and let an agent author it, or seed one from a
   *  template and review it in the builder. */
  interface Props {
    /** Working directory new automations are created in — the project the list
     *  is scoped to, so what you seed lands where you're looking. */
    projectPath: string;
    /** Open the builder on a freshly seeded automation. */
    onOpen: (a: Automation) => void;
    /** Start an empty automation — the "Start from scratch" row. */
    onCreateBlank: () => void;
  }
  let { projectPath, onOpen, onCreateBlank }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.automationsStore;

  let description = $state("");
  let seedingId = $state<string | null>(null);

  // The description, once handed off. Non-null for as long as the create flow
  // card is on screen. No tab is created unless the user explicitly chooses to
  // open the session afterward.
  let draftPrompt = $state<string | null>(null);
  let draftingCwd = $state<string | null>(null);
  let draftingSessionId = $state<string | null>(null);
  let draftingServerId = $state<string | null>(null);
  // The automations that already existed when the handoff started, so the one
  // the agent saves can be told apart from them. `automationsStore` learns about
  // the save through `automation.changed`, with no polling here.
  let automationIdsBeforeDraft = $state(new Set<string>());

  // Newest first, and agent-authored — a template seeded from the ledger below
  // lands in the same list but is created by the user, not by the draft session.
  const savedDraft = $derived(
    draftPrompt === null
      ? null
      : (store.items.find(
          (a) =>
            !automationIdsBeforeDraft.has(a.id) &&
            a.createdBy.kind === "agent" &&
            store.hostFor(a.id) === draftingServerId,
        ) ?? null),
  );

  /** The handoff as three milestones we can actually observe: the session
   *  starting, the agent working, and the automation landing in the store. */
  const draftSteps = $derived([
    {
      label: `Creating automation in ${folderLabel(draftingCwd ?? "")}`,
      state: draftingSessionId ? "done" : "active",
    },
    {
      label: "Building the automation",
      state: !draftingSessionId ? "pending" : savedDraft ? "done" : "active",
    },
    {
      label: "Automation saved to this workspace",
      state: savedDraft ? "done" : "pending",
    },
  ] as const);

  async function submitDescription() {
    const text = description.trim();
    if (!text || draftPrompt !== null) return;
    const cwd = projectPath;
    draftPrompt = text;
    draftingCwd = cwd;
    draftingServerId = serverConnections.connectionFor()?.serverId ?? null;
    if (!draftingServerId) {
      toasts.error("Couldn't start a session: no host is connected");
      dismissDraft();
      return;
    }
    automationIdsBeforeDraft = new Set(store.items.map((a) => a.id));
    description = "";
    try {
      draftingSessionId = await session.createAutomationDraftSession(
        draftAutomationPrompt(text, cwd),
        cwd,
        draftingServerId,
      );
    } catch {
      toasts.error("Couldn't start a session for that description");
      description = text;
      dismissDraft();
    }
  }

  function dismissDraft() {
    draftPrompt = null;
    draftingCwd = null;
    draftingSessionId = null;
    draftingServerId = null;
  }

  async function openDraftingSession() {
    if (!draftingSessionId || !draftingCwd) return;
    try {
      const meta = await resolveSessionMetaRef({
        sessionId: draftingSessionId,
        serverId: draftingServerId ?? undefined,
      });
      if (!meta) throw new Error("Session not found");
      await session.resumeSession({ ...meta, cwd: meta.cwd || draftingCwd });
    } catch {
      toasts.error("Couldn't open that session");
    }
  }

  async function seedTemplate(template: AutomationTemplate) {
    if (seedingId) return;
    const serverId = serverConnections.connectionFor()?.serverId;
    if (!serverId) {
      toasts.error("Couldn't create that automation: no host is connected");
      return;
    }
    seedingId = template.id;
    try {
      const created = await store.create(
        serverId,
        template.name,
        {
          prompt: template.prompt,
          agentProvider: template.agentProvider ?? "claude-code",
          modelId: template.modelId ?? null,
          reasoningEffort: "medium",
          cwd:
            (template.runsInWorkspace
              ? session.staticInfo?.workspacePath
              : null) ?? projectPath,
        },
        template.trigger,
        // Seeded paused: a template carries a schedule, and nothing should run
        // unattended against the repo before anyone has read its instructions.
        false,
      );
      onOpen(created);
    } catch {
      toasts.error("Couldn't create that automation");
    } finally {
      seedingId = null;
    }
  }
</script>

<div class="flex flex-col">
  <!-- Same 30px heading line the list's groups use, so the launchpad reads as
       the next section of the page rather than a panel bolted underneath it. -->
  <div class="flex h-[30px] items-center gap-2.5 px-1.5">
    <span
      class="text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase"
      >Describe it, or start from a template</span
    >
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
  </div>

  {#if draftPrompt !== null}
    <!-- Handed off. The automation itself arrives in the list on its own once
         the agent saves it; this card tracks that arrival. -->
    <div
      class="mt-2 rounded-2xl bg-card shadow-[0_0_0_.5px_var(--hairline-strong)]"
    >
      <div class="flex items-start gap-[11px] pt-3.5 pr-2 pb-3 pl-3">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--running)_13%,transparent)] text-[var(--running)]"
          aria-hidden="true"
        >
          {#if savedDraft}
            <CheckIcon size={12} weight="bold" />
          {:else}
            <CircleNotchIcon
              size={12}
              class="animate-spin [animation-duration:0.9s]"
            />
          {/if}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-[5px] pt-px">
          <span class="flex flex-wrap items-center gap-2.5">
            <span class="text-[14px] font-semibold tracking-[-.01em]">
              {savedDraft
                ? "Automation drafted in a session"
                : "Creating this automation in a session…"}
            </span>
            {#if draftingSessionId}
              <span class="font-mono text-[11px] text-muted-foreground opacity-80"
                >{draftingSessionId.slice(0, 8)}</span
              >
            {/if}
          </span>
          <span
            class="block max-w-[70ch] text-[13px] leading-[1.6] text-pretty text-muted-foreground"
            >“{draftPrompt}”</span
          >
        </span>
        <span class="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] disabled:pointer-events-none disabled:opacity-45"
            onclick={() => void openDraftingSession()}
            disabled={!draftingSessionId}
          >
            Go to session
            <ArrowRightIcon size={11} weight="bold" />
          </button>
          <button
            type="button"
            class="grid size-[26px] cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground"
            onclick={dismissDraft}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <XIcon size={11} />
          </button>
        </span>
      </div>
      <div
        class="flex flex-col gap-2 border-t border-[var(--hairline)] pt-[11px] pr-3.5 pb-3 pl-12"
      >
        {#each draftSteps as step (step.label)}
          {#if step.state === "done"}
            <span
              class="flex items-center gap-[9px] text-[13px] text-[color-mix(in_oklch,var(--foreground)_78%,var(--muted-foreground))]"
            >
              <span
                class="grid size-[13px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--success)_20%,transparent)] text-[var(--success)]"
                aria-hidden="true"
              >
                <CheckIcon size={8} weight="bold" />
              </span>
              {step.label}
            </span>
          {:else if step.state === "active"}
            <span class="flex items-center gap-[9px] text-[13px] font-medium">
              <span
                class="grid size-[13px] shrink-0 place-items-center text-[var(--running)]"
                aria-hidden="true"
              >
                <CircleNotchIcon
                  size={11}
                  class="animate-spin [animation-duration:0.9s]"
                />
              </span>
              {step.label}
            </span>
          {:else}
            <span
              class="flex items-center gap-[9px] text-[13px] text-[color-mix(in_oklch,var(--muted-foreground)_62%,transparent)]"
            >
              <span class="grid size-[13px] shrink-0 place-items-center" aria-hidden="true">
                <span class="size-[5px] rounded-full bg-[var(--idle)]"></span>
              </span>
              {step.label}
            </span>
          {/if}
        {/each}
        {#if savedDraft}
          <span class="mt-0.5 text-[13px] leading-[1.6] text-pretty text-muted-foreground">
            Saved as <span class="font-semibold text-foreground">{savedDraft.name}</span>
            · {triggerSummary(savedDraft.trigger)}. Open the session to review
            the instructions before it runs.
          </span>
        {/if}
      </div>
    </div>
  {:else}
    <div
      class="mt-2 flex h-[46px] w-full items-center gap-2.5 rounded-2xl bg-card pr-1.5 pl-3 shadow-[inset_0_0_0_.5px_var(--hairline-strong)] transition-shadow duration-150 focus-within:shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
    >
      <PencilSimpleIcon size={13} class="shrink-0 text-[var(--primary)]" />
      <input
        type="text"
        bind:value={description}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitDescription();
          }
        }}
        placeholder="Describe the automation…"
        aria-label="Describe the automation"
        class="min-w-0 flex-1 border-0 bg-transparent text-[13px] tracking-[-.005em] caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        class="flex h-[30px] shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] text-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] disabled:pointer-events-none disabled:opacity-45"
        onclick={submitDescription}
        disabled={!description.trim()}
      >
        Create<span class="font-mono text-[11px] opacity-80">↵</span>
      </button>
    </div>
  {/if}

  <div class="mt-[18px] flex flex-col border-t border-[var(--hairline)]">
    {#each AUTOMATION_TEMPLATES as template, i (template.id)}
      <button
        type="button"
        class="group flex cursor-pointer items-center gap-4 rounded-lg border-x-0 border-t-0 border-b border-[var(--hairline)] bg-transparent px-2.5 py-[13px] text-left transition-colors duration-150 hover:bg-[var(--wash-1)] disabled:cursor-wait disabled:opacity-60"
        onclick={() => seedTemplate(template)}
        disabled={seedingId !== null}
      >
        <span
          class="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground opacity-55"
          >{String(i + 1).padStart(2, "0")}</span
        >
        <span
          class="w-[236px] shrink-0 text-[13px] font-[450] tracking-[-.005em] text-pretty @max-[56rem]:w-auto"
          >{template.name}</span
        >
        <span
          class="min-w-0 flex-1 text-[12px] leading-[1.55] text-pretty text-muted-foreground @max-[56rem]:hidden"
          >{template.description}</span
        >
        <span
          class="flex w-[150px] shrink-0 items-center justify-end gap-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground opacity-80 @max-[56rem]:hidden"
        >
          {#if template.trigger.type === "manual"}
            <PlayIcon size={9} weight="fill" class="shrink-0" />
          {:else}
            <ClockIcon size={10} class="shrink-0" />
          {/if}
          {triggerSummary(template.trigger)}
        </span>
        <span
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-muted-foreground opacity-0 shadow-[0_0_0_.5px_var(--hairline-strong)] transition-opacity duration-150 group-hover:opacity-100"
          aria-hidden="true"
        >
          Use
          <ArrowRightIcon size={10} weight="bold" />
        </span>
      </button>
    {/each}
  </div>

  <div class="flex items-center gap-3 px-2.5 pt-3.5">
    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class="text-[13px] font-[450] tracking-[-.005em]"
        >Start from scratch</span
      >
      <span class="text-[12px] text-muted-foreground"
        >Write your own instructions and pick when they run.</span
      >
    </span>
    <button
      type="button"
      class="flex h-7 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-transparent px-3 text-[13px] text-muted-foreground shadow-[0_0_0_.5px_var(--hairline-strong)] transition-colors duration-150 hover:bg-[var(--wash-1)] hover:text-foreground"
      onclick={onCreateBlank}
    >
      New automation
      <ArrowRightIcon size={11} weight="bold" />
    </button>
  </div>
</div>
