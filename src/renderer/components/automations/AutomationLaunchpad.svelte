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
  import { getWorkspaceContext, toasts } from "../../contexts";
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
    /** Open the builder on a freshly seeded automation. */
    onOpen: (a: Automation) => void;
    /** Start an empty automation — the "Start from scratch" row. */
    onCreateBlank: () => void;
  }
  let { onOpen, onCreateBlank }: Props = $props();

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
  // The automations that already existed when the handoff started, so the one
  // the agent saves can be told apart from them. `automationsStore` learns about
  // the save over the `automations-changed` topic, with no polling here.
  let automationIdsBeforeDraft = $state(new Set<string>());

  // Newest first, and agent-authored — a template seeded from the ledger below
  // lands in the same list but is created by the user, not by the draft session.
  const savedDraft = $derived(
    draftPrompt === null
      ? null
      : (store.items.find(
          (a) => !automationIdsBeforeDraft.has(a.id) && a.createdBy.kind === "agent",
        ) ?? null),
  );

  /** The handoff as three milestones we can actually observe: the session
   *  starting, the agent working, and the automation landing in the store. */
  const draftSteps = $derived([
    {
      label: `Session started in ${folderLabel(draftingCwd ?? "")}`,
      state: draftingSessionId ? "done" : "active",
    },
    {
      label: "Reading the repo and writing the automation",
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
    const cwd = session.galleryProjectPath;
    draftPrompt = text;
    draftingCwd = cwd;
    automationIdsBeforeDraft = new Set(store.items.map((a) => a.id));
    description = "";
    try {
      draftingSessionId = await session.createAutomationDraftSession(
        draftAutomationPrompt(text, cwd),
        cwd,
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
  }

  async function openDraftingSession() {
    if (!draftingSessionId || !draftingCwd) return;
    try {
      const api = session.activeTabId
        ? session.apiFor(session.activeTabId)
        : window.solus;
      const meta = await api.getSessionInfo(draftingSessionId);
      if (!meta) throw new Error("Session not found");
      await session.resumeSession({ ...meta, cwd: meta.cwd || draftingCwd });
    } catch {
      toasts.error("Couldn't open that session");
    }
  }

  async function seedTemplate(template: AutomationTemplate) {
    if (seedingId) return;
    seedingId = template.id;
    try {
      const created = await store.create(
        template.name,
        {
          prompt: template.prompt,
          agentProvider: "claude-code",
          modelId: null,
          reasoningEffort: "medium",
          cwd: session.galleryProjectPath,
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
  <div class="flex items-center gap-3.5">
    <span
      class="text-[0.65625rem] font-semibold tracking-[0.13em] text-(--solus-text-tertiary) uppercase"
      >Describe it, or start from a template</span
    >
    <span
      class="h-px flex-1 bg-[color-mix(in_srgb,var(--solus-container-border)_45%,transparent)]"
      aria-hidden="true"
    ></span>
  </div>

  {#if draftPrompt !== null}
    <!-- Handed off. The automation itself arrives in the list on its own once
         the agent saves it; this card tracks that arrival. -->
    <div
      class="mt-4.5 rounded-xl border border-[color-mix(in_srgb,var(--solus-container-border)_82%,transparent)] bg-(--solus-input-pill-bg)"
    >
      <div class="flex items-start gap-3.5 p-[0.9375rem] pr-3.5">
        <span
          class="grid size-7 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--solus-accent)_12%,transparent)] text-(--solus-accent)"
          aria-hidden="true"
        >
          {#if savedDraft}
            <CheckIcon size={14} weight="bold" />
          {:else}
            <CircleNotchIcon size={14} class="animate-spin [animation-duration:0.9s]" />
          {/if}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <span class="flex flex-wrap items-center gap-2.5">
            <span
              class="text-[0.84375rem] font-semibold tracking-[-0.015em] text-(--solus-text-primary)"
            >
              {savedDraft
                ? "Automation drafted in a session"
                : "Creating this automation in a session…"}
            </span>
            {#if draftingSessionId}
              <span
                class="font-mono text-[0.71875rem] tracking-[-0.01em] text-[color-mix(in_srgb,var(--solus-text-tertiary)_88%,transparent)]"
                >{draftingSessionId.slice(0, 8)}</span
              >
            {/if}
          </span>
          <span
            class="block max-w-[40rem] text-[0.78125rem] leading-[1.55] text-pretty text-(--solus-text-tertiary)"
            >“{draftPrompt}”</span
          >
        </span>
        <span class="flex shrink-0 items-center gap-1.5 pt-px">
          <button
            type="button"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-(--solus-accent) px-3.5 text-[0.75rem] font-semibold text-[var(--solus-accent-contrast,#fff)] transition-[filter,opacity] duration-100 hover:brightness-[1.07] disabled:cursor-not-allowed disabled:opacity-45"
            onclick={() => void openDraftingSession()}
            disabled={!draftingSessionId}
          >
            Go to session
            <ArrowRightIcon size={11} weight="bold" />
          </button>
          <button
            type="button"
            class="grid size-7.5 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
            onclick={dismissDraft}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <XIcon size={13} />
          </button>
        </span>
      </div>
      <div
        class="flex flex-col gap-2.5 border-t border-[color-mix(in_srgb,var(--solus-container-border)_42%,transparent)] px-[0.9375rem] pt-3 pb-3.5 pl-14"
      >
        {#each draftSteps as step (step.label)}
          {#if step.state === "done"}
            <span
              class="flex items-center gap-2.5 text-[0.78125rem] text-(--solus-text-secondary)"
            >
              <span
                class="grid size-3.5 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--solus-art-3)_20%,transparent)] text-(--solus-art-3)"
                aria-hidden="true"
              >
                <CheckIcon size={9} weight="bold" />
              </span>
              {step.label}
            </span>
          {:else if step.state === "active"}
            <span
              class="flex items-center gap-2.5 text-[0.78125rem] font-medium text-(--solus-text-primary)"
            >
              <span
                class="grid size-3.5 shrink-0 place-items-center text-(--solus-accent)"
                aria-hidden="true"
              >
                <CircleNotchIcon size={11} class="animate-spin [animation-duration:0.9s]" />
              </span>
              {step.label}
            </span>
          {:else}
            <span
              class="flex items-center gap-2.5 text-[0.78125rem] text-[color-mix(in_srgb,var(--solus-text-tertiary)_62%,transparent)]"
            >
              <span class="grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
                <span class="size-1.5 rounded-full bg-current"></span>
              </span>
              {step.label}
            </span>
          {/if}
        {/each}
        {#if savedDraft}
          <span
            class="mt-0.5 text-[0.78125rem] leading-[1.55] text-pretty text-(--solus-text-tertiary)"
          >
            Saved as <span class="font-semibold text-(--solus-text-primary)"
              >{savedDraft.name}</span
            >
            · {triggerSummary(savedDraft.trigger)}. Open the session to review the
            instructions before it runs.
          </span>
        {/if}
      </div>
    </div>
  {:else}
    <div
      class="mt-4.5 flex h-[3.4375rem] w-full items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--solus-container-border)_75%,transparent)] bg-(--solus-input-pill-bg) pr-2 pl-4 transition-[border-color] duration-150 focus-within:border-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
    >
      <PencilSimpleIcon size={15} class="shrink-0 text-(--solus-accent)" />
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
        class="min-w-0 flex-1 border-0 bg-transparent text-sm text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary) focus:outline-none"
      />
      <button
        type="button"
        class="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full border-0 bg-(--solus-accent) px-[0.9375rem] text-[0.78125rem] font-semibold text-[var(--solus-accent-contrast,#fff)] transition-[filter,opacity] duration-100 hover:brightness-[1.07] disabled:cursor-not-allowed disabled:opacity-45"
        onclick={submitDescription}
        disabled={!description.trim()}
      >
        Create
      </button>
    </div>
  {/if}

  <div
    class="-mx-3.5 mt-6.5 flex flex-col border-t border-[color-mix(in_srgb,var(--solus-container-border)_42%,transparent)]"
  >
    {#each AUTOMATION_TEMPLATES as template, i (template.id)}
      <button
        type="button"
        class="flex cursor-pointer items-center gap-[1.125rem] border-x-0 border-t-0 border-b border-[color-mix(in_srgb,var(--solus-container-border)_42%,transparent)] bg-transparent px-3.5 py-4 text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) disabled:cursor-wait disabled:opacity-60"
        onclick={() => seedTemplate(template)}
        disabled={seedingId !== null}
      >
        <span
          class="w-6.5 shrink-0 pt-px text-right font-mono text-[0.6875rem] font-medium tracking-[0.04em] text-[color-mix(in_srgb,var(--solus-text-tertiary)_75%,transparent)]"
          >{String(i + 1).padStart(2, "0")}</span
        >
        <span
          class="shrink-0 basis-[15.625rem] text-[0.875rem] font-semibold tracking-[-0.018em] text-(--solus-text-primary) @max-[56rem]:basis-auto"
          >{template.name}</span
        >
        <span
          class="min-w-0 flex-1 text-[0.78125rem] leading-[1.5] text-pretty text-(--solus-text-tertiary) @max-[56rem]:hidden"
          >{template.description}</span
        >
        <span
          class="flex shrink-0 basis-[10.5rem] items-center justify-end gap-1.5 font-mono text-[0.71875rem] tracking-[-0.01em] text-(--solus-text-tertiary) @max-[56rem]:hidden"
        >
          {#if template.trigger.type === "manual"}
            <PlayIcon size={10} weight="fill" class="shrink-0" />
          {:else}
            <ClockIcon size={11} class="shrink-0" />
          {/if}
          {triggerSummary(template.trigger)}
        </span>
      </button>
    {/each}
  </div>

  <div class="-mx-3.5 flex items-center gap-3 px-3.5 pt-4.5">
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        class="text-[0.84375rem] font-semibold tracking-[-0.015em] text-(--solus-text-primary)"
        >Start from scratch</span
      >
      <span class="text-[0.78125rem] text-(--solus-text-tertiary)"
        >Write your own instructions and pick when they run.</span
      >
    </span>
    <button
      type="button"
      class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--solus-container-border)_85%,transparent)] bg-transparent px-3.5 text-xs font-medium text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
      onclick={onCreateBlank}
    >
      New automation
      <ArrowRightIcon size={11} weight="bold" />
    </button>
  </div>
</div>
