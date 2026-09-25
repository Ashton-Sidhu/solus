<script lang="ts">
  import { untrack } from "svelte";
  import { Aperture as ApertureIcon, ArrowUpRight as UseLensIcon } from "@lucide/svelte";
  import type { ReviewLensSource, SavedLens } from "@solus/contracts/review";
  import { getAgentContext, getSettingsContext } from "../../contexts";
  import type { ResolvedReviewAgent } from "../../lib/reviewAgent";
  import { CommentComposer } from "../ui/comment-composer";
  import { Button } from "../ui/button";
  import SessionChip from "../pickers/SessionChip.svelte";
  import { combinedLensSource, lensPickerSelection, MAX_COMBINED_LENSES } from "./lib/lens-surface";

  /**
   * How a lens starts: pick a saved lens, tick several to combine them into one
   * lens with a tab each, or type a one-time prompt. The same
   * panel is the empty state and the "New lens" step, which replaces the lens
   * that is there — so that case asks first (docs/plans/review-lenses.md).
   * The model starts at the review companion in Settings; a change here is for
   * this lens only.
   */
  let {
    savedLenses,
    replacesTitle = null,
    disabled = false,
    disabledReason,
    onGenerate,
    onSavePrompt,
    onCancel,
  }: {
    savedLenses: SavedLens[];
    /** The title of the lens a new one would replace, or null for none. */
    replacesTitle?: string | null;
    disabled?: boolean;
    disabledReason?: string;
    onGenerate: (source: ReviewLensSource, agent: ResolvedReviewAgent) => void;
    /** Keep a one-time prompt in Settings as a saved lens. */
    onSavePrompt: (prompt: string) => void;
    /** Present when there is a lens to go back to. */
    onCancel?: () => void;
  } = $props();

  const settings = getSettingsContext();
  const agentContext = getAgentContext();

  let selection = $state(untrack(() => lensPickerSelection(settings, agentContext.metadata)));
  let pending = $state<ReviewLensSource | null>(null);
  let draft = $state("");
  let composerKey = $state(0);
  /** Saved lenses ticked to combine, in the order they were ticked. */
  let combineIds = $state<string[]>([]);
  const combined = $derived(
    combineIds.flatMap((id) => savedLenses.filter((lens) => lens.id === id)),
  );

  function toggleCombine(id: string, checked: boolean) {
    if (!checked) combineIds = combineIds.filter((combineId) => combineId !== id);
    else if (!combineIds.includes(id) && combineIds.length < MAX_COMBINED_LENSES) combineIds = [...combineIds, id];
  }

  function run(source: ReviewLensSource) {
    onGenerate(source, { agent: selection.provider, model: selection.modelId, reasoningEffort: selection.reasoningEffort });
  }

  function choose(source: ReviewLensSource) {
    if (disabled) return;
    if (replacesTitle) {
      pending = source;
      return;
    }
    run(source);
  }
</script>

<!-- Centred in the Lens canvas, the same way the guide's empty offer is, so
     the two tabs of one review read as one surface. -->
<div
  class="flex min-h-full items-center justify-center px-[clamp(20px,2.6cqi,56px)] py-10 text-workspace-chrome"
  data-testid="lens-start"
>
  <div class="lens-start flex w-full max-w-[34rem] flex-col items-center">
    <!-- A neutral medallion, not an accent one: the accent belongs to the
         Generate button, which is the actual offer. -->
    <span
      class="flex size-[44px] shrink-0 items-center justify-center rounded-2xl bg-[color:color-mix(in_oklab,var(--muted)_70%,transparent)] text-muted-foreground"
      aria-hidden="true"
    >
      <ApertureIcon size={20} />
    </span>

    <h2 class="mt-4 font-medium text-foreground">{replacesTitle ? "New lens" : "Make a lens"}</h2>

    <p class="mt-2 max-w-[28rem] text-center leading-[1.7] text-pretty text-muted-foreground">
      A lens is an HTML view of this change, made from your prompt. It can explain the change or draw it.
      {#if replacesTitle}The new lens replaces “{replacesTitle}”. You can restore it after.{/if}
    </p>

    {#if pending}
      <div
        class="mt-5 flex w-full flex-wrap items-center gap-2 rounded-xl border border-(--hairline) bg-(--wash-1) px-3 py-2.5"
        role="alert"
      >
        <span class="min-w-0 flex-1">Replace “{replacesTitle}” with “{pending.name}”?</span>
        <Button variant="ghost" size="xs" onclick={() => (pending = null)}>Keep it</Button>
        <Button
          size="xs"
          onclick={() => {
            const source = pending;
            pending = null;
            if (source) run(source);
          }}
        >
          Replace
        </Button>
      </div>
    {/if}

    <div
      class="mt-6 w-full rounded-2xl border border-(--solus-container-border) bg-(--solus-popover-bg) px-3 py-2.5 shadow-[0_0.75rem_2rem_-1.5rem_rgba(0,0,0,0.35)] transition-[border-color,box-shadow] focus-within:border-[color:color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
    >
      {#key composerKey}
        <CommentComposer
          surface="embedded"
          placeholder="Describe a one-time lens…"
          ariaLabel="One-time lens prompt"
          submitLabel="Generate"
          cancelLabel={onCancel ? "Back" : "Clear"}
          autoFocus={false}
          {disabled}
          onFormValueChange={(value) => (draft = value)}
          onSave={(prompt) => {
            choose({ name: "One-time lens", prompt });
            if (!replacesTitle) composerKey++;
          }}
          onCancel={() => {
            if (onCancel) onCancel();
            else composerKey++;
          }}
        >
          {#snippet secondaryActions()}
            <div class="flex min-w-0 items-center gap-1">
              <SessionChip
                bind:selection
                menuSide="bottom"
                allowFastMode={false}
                {disabled}
                ariaLabel="Lens model and reasoning"
                returnFocusOnClose
              />
              <Button
                variant="ghost"
                size="xs"
                class="shrink-0"
                disabled={!draft.trim()}
                title="Keep this prompt in Settings → Review"
                onclick={() => onSavePrompt(draft.trim())}
              >
                Save as lens
              </Button>
            </div>
          {/snippet}
        </CommentComposer>
      {/key}
    </div>

    {#if savedLenses.length > 0}
      <section class="mt-6 flex w-full flex-col gap-2" aria-label="Saved lenses">
        <h3 class="px-1 text-xs text-(--solus-text-tertiary)">
          Or use a saved lens. Tick up to {MAX_COMBINED_LENSES} to make one lens with a tab for each.
        </h3>
        <ul class="grid grid-cols-1 gap-1.5 @min-[36rem]/pane:grid-cols-2">
          {#each savedLenses as lens (lens.id)}
            {@const isCombined = combineIds.includes(lens.id)}
            <li class="relative flex">
              <!-- A sibling of the card, not inside it: the card is a button
                   that generates this lens alone. -->
              <input
                type="checkbox"
                class="absolute top-3 right-3 z-[1] size-3.5 cursor-pointer accent-(--solus-accent) disabled:cursor-not-allowed pointer-coarse:size-5"
                aria-label="Combine {lens.name || 'Untitled lens'}"
                checked={isCombined}
                disabled={disabled || (!isCombined && combineIds.length >= MAX_COMBINED_LENSES)}
                title={!isCombined && combineIds.length >= MAX_COMBINED_LENSES
                  ? `A lens can combine at most ${MAX_COMBINED_LENSES} saved lenses`
                  : "Combine into one lens"}
                onchange={(event) => toggleCombine(lens.id, event.currentTarget.checked)}
              />
              <button
                type="button"
                class="group flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden rounded-xl border border-(--hairline) px-3 py-2.5 text-left transition-[background-color,border-color] hover:border-(--solus-container-border) hover:bg-(--wash-2) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-3"
                {disabled}
                title={disabled ? disabledReason : undefined}
                onclick={() => choose({ savedLensId: lens.id, name: lens.name, prompt: lens.prompt })}
              >
                <span class="flex w-full min-w-0 items-center gap-1.5 pr-6 pointer-coarse:pr-8">
                  <span class="min-w-0 flex-1 truncate font-medium text-foreground">{lens.name || "Untitled lens"}</span>
                  <UseLensIcon
                    size={13}
                    class="shrink-0 text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100"
                    aria-hidden="true"
                  />
                </span>
                <span class="line-clamp-2 w-full text-xs leading-normal text-(--solus-text-tertiary)">{lens.prompt}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if combined.length >= 2}
          <div class="flex flex-wrap items-center gap-2 px-1" aria-live="polite">
            <span class="min-w-0 flex-1 truncate text-xs text-(--solus-text-secondary)">
              {combined.length} tabs: {combined.map((lens) => lens.name || "Untitled lens").join(", ")}
            </span>
            <Button variant="ghost" size="xs" onclick={() => (combineIds = [])}>Clear</Button>
            <Button size="xs" {disabled} onclick={() => choose(combinedLensSource(combined))}>
              Generate as one lens
            </Button>
          </div>
        {/if}
      </section>
    {:else}
      <p class="mt-4 text-center text-xs text-(--solus-text-tertiary)">
        No saved lenses yet. Add them in Settings → Review.
      </p>
    {/if}
  </div>
</div>

<style>
  .lens-start {
    animation: lens-start-in 0.3s ease-out backwards;
  }
  @keyframes lens-start-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lens-start {
      animation: none;
    }
  }
</style>
