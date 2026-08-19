<script lang="ts">
  import { PauseIcon, PencilSimpleIcon, PlayIcon, TrashIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import PanelSection from "./PanelSection.svelte";
  import {
    goalMetaLine,
    goalStatusColor,
    goalStatusLabel,
    isGoalTerminal,
    objectiveOverflows,
  } from "./lib/goal-status";

  interface Props {
    sessionId: string;
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown?: (event: PointerEvent) => void;
    /** The rail simply stops rendering the section once the goal is gone; a host
     *  that gave the card a surface of its own (the pill body) has to close it. */
    onCleared?: () => void;
  }
  let { sessionId, collapsed, onToggle, onResizePointerDown, onCleared }: Props = $props();

  const workspace = getWorkspaceContext();
  const session = $derived(workspace.sessions[sessionId]);
  const goal = $derived(session?.goal ?? null);
  const goalStatus = $derived(
    goal && session?.run.provider === "claude-code" && session.status === "completed" ? "complete" : goal?.status,
  );
  const canMutateGoal = $derived(session?.run.provider === "codex");
  const isPaused = $derived(goalStatus === "paused");
  const isTerminal = $derived(!!goalStatus && isGoalTerminal(goalStatus));
  const budgetPercent = $derived(
    goal?.tokenBudget && goal.tokensUsed !== undefined
      ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100))
      : null,
  );

  // A multi-paragraph objective would otherwise push the meta line, the budget
  // bar and every section below it off the rail, so the card reads six lines and
  // the rest is opt-in. Expanding scrolls inside the card, it doesn't grow it.
  const isLongObjective = $derived(!!goal && objectiveOverflows(goal.objective));
  let objectiveExpanded = $state(false);

  let isEditing = $state(false);
  let objectiveDraft = $state("");
  let confirmingClear = $state(false);
  let saving = $state(false);

  // Both destructive-adjacent modes live in the body, so arming either one from
  // the header has to open the section or the user aims at nothing.
  function expand() {
    if (collapsed) onToggle();
  }

  function beginEdit() {
    if (!goal) return;
    objectiveDraft = goal.objective;
    confirmingClear = false;
    isEditing = true;
    expand();
  }

  function armClear() {
    isEditing = false;
    confirmingClear = true;
    expand();
  }

  async function updateGoal(update: { objective?: string; status?: "active" | "paused" }) {
    if (!session?.agentSessionId || !goal) return;
    saving = true;
    try {
      await workspace.setThreadGoal(session.id, update);
      isEditing = false;
    } catch (error) {
      toasts.error("Couldn't update goal", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving = false;
      requestInputFocus();
    }
  }

  async function saveObjective() {
    const objective = objectiveDraft.trim();
    if (!objective || objective.length > 4000) return;
    await updateGoal({ objective });
  }

  async function clearGoal() {
    if (!session?.agentSessionId) return;
    saving = true;
    try {
      await workspace.clearThreadGoal(session.id);
      confirmingClear = false;
      onCleared?.();
    } catch (error) {
      toasts.error("Couldn't clear goal", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving = false;
      requestInputFocus();
    }
  }
</script>

{#snippet controls()}
  <span class="inline-flex min-w-0 items-center gap-1">
    {#if goal}
      <!-- The word carries the status by itself: it borrows the section title's
           micro-caps so the header line stays one rhythm, and takes the status
           colour rather than trailing a separate indicator. -->
      <span
        class="mr-1 min-w-0 truncate font-medium uppercase"
        style:color={goalStatusColor(goalStatus ?? goal.status)}
      >
        {goalStatusLabel(goalStatus ?? goal.status)}
      </span>
    {/if}
    <!-- The controls sit back until the card is approached: at rest the header
         reads as status, on hover it reads as a toolbar. -->
    {#if canMutateGoal}
      <span
        class="inline-flex items-center gap-px opacity-65 transition-opacity duration-150 group-hover/section:opacity-100 group-focus-within/section:opacity-100 motion-reduce:transition-none"
      >
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-(--solus-text-tertiary)"
        aria-label="Edit goal"
        title="Edit goal"
        disabled={saving || isEditing}
        onclick={(e) => {
          e.stopPropagation();
          beginEdit();
        }}
      >
        <PencilSimpleIcon size={12} />
      </Button>
      {#if !isTerminal}
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-(--solus-text-tertiary)"
          aria-label={isPaused ? "Resume goal" : "Pause goal"}
          title={isPaused ? "Resume goal" : "Pause goal"}
          disabled={saving}
          onclick={(e) => {
            e.stopPropagation();
            void updateGoal({ status: isPaused ? "active" : "paused" });
          }}
        >
          {#if isPaused}<PlayIcon size={12} weight="fill" />{:else}<PauseIcon size={12} weight="fill" />{/if}
        </Button>
      {/if}
      <!-- The ghost variant sets its own dark:hover:bg-*, which is a separate
           merge group — the destructive wash has to be restated there or dark
           mode falls back to a neutral hover. -->
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-(--solus-text-tertiary) hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20"
        aria-label="Delete goal"
        title="Delete goal"
        disabled={saving || confirmingClear}
        onclick={(e) => {
          e.stopPropagation();
          armClear();
        }}
      >
        <TrashIcon size={12} />
      </Button>
      </span>
    {/if}
  </span>
{/snippet}

<PanelSection title="Goal" {collapsed} {onToggle} {onResizePointerDown} headerExtra={controls}>
  {#if goal}
    <div class="flex flex-col gap-1.5 px-2 pb-1">
      {#if isEditing}
        <div class="flex flex-col gap-1.5">
          <!-- A filled field would stack a second grey on the card's own grey.
               The field stays on the card surface and a hairline carries the
               edge, so editing changes the outline, not the colour. -->
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            bind:value={objectiveDraft}
            maxlength="4000"
            rows="4"
            autofocus
            aria-label="Goal objective"
            class="w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--solus-text-primary)_12%,transparent)] bg-transparent px-1.5 py-1 text-xs leading-5 text-(--solus-text-primary) outline-none focus:border-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)]"
          ></textarea>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs tabular-nums text-(--solus-text-tertiary)">
              {objectiveDraft.length} / 4,000
            </span>
            <span class="flex gap-1">
              <Button variant="ghost" size="xs" disabled={saving} onclick={() => (isEditing = false)}>Cancel</Button>
              <Button size="xs" disabled={saving || !objectiveDraft.trim()} onclick={saveObjective}>Save</Button>
            </span>
          </div>
        </div>
      {:else}
        <!-- The objective is the subject of the card, so it carries the primary
             ink; every reading below it steps down from here. -->
        <p
          class="m-0 text-xs leading-5 text-pretty whitespace-pre-wrap text-(--solus-text-primary) {objectiveExpanded
 ? 'max-h-56 overflow-y-auto overscroll-contain'
 : 'line-clamp-6'}"
        >
          {goal.objective}
        </p>
        {#if isLongObjective}
          <button
            class="-mt-0.5 cursor-pointer self-start border-none bg-transparent p-0 text-xs text-(--solus-text-tertiary) transition-colors duration-150 hover:text-(--solus-text-primary)"
            type="button"
            onclick={() => (objectiveExpanded = !objectiveExpanded)}
          >
            {objectiveExpanded ? "Show less" : "Show more"}
          </button>
        {/if}
      {/if}

      <!-- Cost and elapsed are footnotes to the objective, not readings worth a
           grid of their own — one tertiary line, the same weight the rail gives
           any other trailing value. -->
      <div class="text-xs tabular-nums text-(--solus-text-tertiary)">{goalMetaLine(goal)}</div>

      {#if goal.tokenBudget !== undefined}
        <div
          class="h-0.5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--solus-text-primary)_9%,transparent)]"
          role="progressbar"
          aria-label="Token budget"
          aria-valuenow={budgetPercent ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            style:width={`${budgetPercent ?? 0}%`}
          ></div>
        </div>
      {/if}

      {#if confirmingClear}
        <!-- Deleting a goal drops its whole record, so it arms in place and
             waits for a second, deliberate click — same as discarding changes. -->
        <div class="flex flex-col gap-1 rounded-md border border-destructive/20 p-1.5">
          <p class="m-0 text-xs leading-4 text-(--solus-text-tertiary)">
            Deletes this goal and its progress. This can't be undone.
          </p>
          <div class="flex justify-end gap-1">
            <Button variant="ghost" size="xs" disabled={saving} onclick={() => (confirmingClear = false)}>Keep</Button>
            <Button variant="destructive" size="xs" disabled={saving} onclick={clearGoal}>Delete</Button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</PanelSection>
