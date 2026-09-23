<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    FilePen as WorkingTreeIcon,
    GitBranch as GitBranchIcon,
    GitCommitHorizontal as TurnIcon,
    MessagesSquare as SessionIcon,
  } from "@lucide/svelte";
  import type { DiffScope, TurnSnapshot } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    REVIEW_SCOPE_LABELS,
    diffScopeForReviewScope,
    reviewScopeLabel,
    type ReviewScopeKind,
  } from "./lib/review-header";

  /**
   * Which change the review reads: the whole branch against its target, the
   * session's own changes or one of its turns, or the uncommitted working tree.
   * The host owns the scope, so a choice goes back to it and the map, the guide
   * and the diff all read the new scope.
   */
  let {
    scope,
    turns,
    selectedTurnIndex,
    onSelect,
  }: {
    scope: ReviewScopeKind;
    /** Empty where turns are not a scope this panel can take. */
    turns: TurnSnapshot[];
    selectedTurnIndex: number | null;
    /** Absent chooses the branch review. */
    onSelect: (scope: DiffScope | undefined) => void;
  } = $props();

  let open = $state(false);

  const scopeOptions = [
    { value: "branch" as const, icon: GitBranchIcon },
    { value: "session" as const, icon: SessionIcon },
    { value: "working-tree" as const, icon: WorkingTreeIcon },
  ];
  const label = $derived(reviewScopeLabel(scope, turns, selectedTurnIndex));
  const TriggerIcon = $derived(
    selectedTurnIndex !== null
      ? TurnIcon
      : (scopeOptions.find((option) => option.value === scope)?.icon ?? GitBranchIcon),
  );
  // Newest first: the turn just finished is the one most often read.
  const turnsNewestFirst = $derived(turns.toReversed());
  const latestTurnIndex = $derived(turns.at(-1)?.index ?? null);
  const turnStepHint = $derived(
    [comboHint("diff-panel.prev-turn"), comboHint("diff-panel.next-turn")].filter(Boolean).join(" "),
  );

  function selectScope(kind: ReviewScopeKind) {
    if (kind === scope && selectedTurnIndex === null) return;
    onSelect(diffScopeForReviewScope(kind));
  }

  function selectTurn(index: number) {
    if (index === selectedTurnIndex) return;
    onSelect({ kind: "turn", index });
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="no-drag flex h-[1.625rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 text-workspace-chrome transition-[background-color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {open
          ? 'bg-[var(--wash-2)]'
          : 'bg-transparent hover:bg-[var(--wash-2)]'}"
        aria-label={`Diff scope: ${label}`}
        data-testid="review-scope-picker"
      >
        <TriggerIcon class="size-3 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
        <span class="whitespace-nowrap tabular-nums text-(--solus-text-primary)">{label}</span>
        <CaretDownIcon class="size-2.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(15rem,calc(100vw-2rem))]"
  >
    <DropdownMenu.Label>Compare</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={selectedTurnIndex === null ? scope : ""}>
      {#each scopeOptions as option (option.value)}
        <DropdownMenu.RadioItem value={option.value} onSelect={() => selectScope(option.value)}>
          <option.icon size={14} />
          <span class="whitespace-nowrap">{REVIEW_SCOPE_LABELS[option.value]}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>

    {#if turns.length > 0 && latestTurnIndex !== null}
      <DropdownMenu.Separator />
      <DropdownMenu.RadioGroup value={selectedTurnIndex === latestTurnIndex ? "latest" : ""}>
        <DropdownMenu.RadioItem value="latest" onSelect={() => selectTurn(latestTurnIndex)}>
          <TurnIcon size={14} />
          <span class="whitespace-nowrap">Latest turn</span>
        </DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>
          <TurnIcon size={14} />
          <span class="whitespace-nowrap">Turn</span>
          {#if turnStepHint}
            <DropdownMenu.Shortcut>{turnStepHint}</DropdownMenu.Shortcut>
          {/if}
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="max-h-72 w-auto min-w-44 overflow-y-auto">
          <DropdownMenu.RadioGroup value={selectedTurnIndex === null ? "" : String(selectedTurnIndex)}>
            {#each turnsNewestFirst as turn, i (turn.index)}
              <DropdownMenu.RadioItem value={String(turn.index)} onSelect={() => selectTurn(turn.index)}>
                <span class="whitespace-nowrap">Turn {turns.length - i}</span>
                <span class="ml-auto shrink-0 tabular-nums text-(--solus-art-3)">+{turn.additions}</span>
                <span class="shrink-0 tabular-nums text-(--solus-stop-bg)">−{turn.deletions}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
