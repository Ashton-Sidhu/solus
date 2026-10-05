<script lang="ts">
  import { Check as CheckIcon, Flag as FlagIcon, X as ClearIcon } from "@lucide/svelte";
  import type { TurnFlag, TurnFlagKind } from "@solus/contracts/observability-types";
  import { Button } from "../ui/button";
  import * as Popover from "../ui/popover";
  import { Textarea } from "../ui/textarea";
  import { flagChoice, flagColor, flagTitle, TURN_FLAG_CHOICES } from "./lib/turn-flags";

  /**
   * The person's mark on this turn: one chip in the action row that says what
   * the mark is, and a popover that sets it, clears it, and holds the reason.
   *
   * Marks are what make the query surface useful later — "show me every turn
   * I called too slow" — so the choice is one click, and the reason is typed
   * after, into a field that saves when it is left or the popover closes,
   * never a dialog that has to be confirmed. The reason lives in the popover
   * and the chip's hover, not beside the chip, so the action row stays one
   * line of equal controls.
   */
  interface Props {
    flag: Pick<TurnFlag, "kind" | "note"> | null;
    onSet: (kind: TurnFlagKind, note: string) => void;
    onClear: () => void;
    /** The reader may see the mark but not set one: a viewer of a shared report. */
    readOnly?: boolean;
  }

  let { flag, onSet, onClear, readOnly = false }: Props = $props();

  let open = $state(false);
  let noteDraft = $state("");
  // The draft follows the stored note when the turn changes underneath it —
  // stepping to the next row must not carry the last row's reason along.
  $effect(() => {
    noteDraft = flag?.note ?? "";
  });

  const chosen = $derived(flag ? flagChoice(flag.kind) : null);

  function saveNote(): void {
    if (!flag) return;
    if (noteDraft.trim() === flag.note) return;
    onSet(flag.kind, noteDraft);
  }

  function clear(): void {
    open = false;
    onClear();
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) saveNote();
  }}
>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="sm"
        class="h-6.5 max-w-56 gap-2 overflow-hidden rounded-full px-3 text-insights-chrome bg-background shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[color,background-color,scale] hover:bg-[var(--wash-1)] active:scale-[0.96] aria-expanded:bg-[var(--wash-3)] pointer-coarse:h-10 {flag
          ? ''
          : 'text-foreground'}"
        style={flag ? `color:${flagColor(flag.kind)}` : undefined}
        title={readOnly
          ? "Shared with you to view. Commenters and editors can mark it."
          : flag
            ? flagTitle(flag.kind, flag.note)
            : "Mark this turn"}
        disabled={readOnly}
      >
        {#if chosen}
          <chosen.icon class="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span class="truncate">{chosen.label}</span>
        {:else}
          <FlagIcon class="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span class="truncate">Mark</span>
        {/if}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content align="end" sideOffset={6} class="w-64 max-w-[calc(100vw-2rem)] gap-2 p-1.5">
    <div class="flex flex-col" role="radiogroup" aria-label="Mark this turn">
      {#each TURN_FLAG_CHOICES as choice (choice.kind)}
        {@const selected = flag?.kind === choice.kind}
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-workspace-chrome outline-none transition-colors hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)] pointer-coarse:h-10 {selected
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => onSet(choice.kind, noteDraft)}
        >
          <choice.icon class="size-3.5 shrink-0" style="color:{flagColor(choice.kind)}" aria-hidden="true" />
          <span class="flex-1 truncate">{choice.label}</span>
          {#if selected}
            <CheckIcon class="size-3.5 shrink-0" aria-hidden="true" />
          {/if}
        </button>
      {/each}
    </div>
    {#if flag}
      <div class="flex flex-col gap-1.5 px-1 pt-1 pb-0.5 shadow-[inset_0_0.5px_0_var(--hairline)]">
        <Textarea
          class="mt-1.5 min-h-14 text-workspace-chrome"
          dictation={false}
          rows={2}
          placeholder="Why? Saved when you leave the field."
          aria-label="Why this turn is marked"
          bind:value={noteDraft}
          onblur={saveNote}
          onkeydown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              saveNote();
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          class="h-8 justify-start gap-2 px-1 text-workspace-chrome text-muted-foreground hover:text-foreground pointer-coarse:h-10"
          onclick={clear}
        >
          <ClearIcon class="size-3.5" aria-hidden="true" />
          Clear mark
        </Button>
      </div>
    {/if}
  </Popover.Content>
</Popover.Root>
