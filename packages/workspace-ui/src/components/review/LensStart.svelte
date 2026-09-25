<script lang="ts">
  import { Aperture as ApertureIcon } from "@lucide/svelte";
  import type { ReviewLensSource, SavedLens } from "@solus/contracts/review";
  import { CommentComposer } from "../ui/comment-composer";
  import { Button } from "../ui/button";

  /**
   * How a lens starts: pick a saved lens, or type a one-time prompt. The same
   * panel is the empty state and the "New lens" step, which replaces the lens
   * that is there — so that case asks first (docs/plans/review-lenses.md).
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
    onGenerate: (source: ReviewLensSource) => void;
    /** Keep a one-time prompt in Settings as a saved lens. */
    onSavePrompt: (prompt: string) => void;
    /** Present when there is a lens to go back to. */
    onCancel?: () => void;
  } = $props();

  let pending = $state<ReviewLensSource | null>(null);
  let draft = $state("");
  let composerKey = $state(0);

  function choose(source: ReviewLensSource) {
    if (disabled) return;
    if (replacesTitle) {
      pending = source;
      return;
    }
    onGenerate(source);
  }
</script>

<div class="mx-auto flex w-full max-w-[36rem] flex-col gap-4 px-5 py-8 text-workspace-chrome" data-testid="lens-start">
  <div class="flex items-start gap-3">
    <ApertureIcon size={18} class="mt-0.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
    <div class="flex min-w-0 flex-col gap-1">
      <h2 class="font-medium text-foreground">{replacesTitle ? "New lens" : "Make a lens"}</h2>
      <p class="text-(--solus-text-secondary)">
        A lens is an HTML view of this change, made from your prompt. It can explain the change or draw it.
        {#if replacesTitle}The new lens replaces “{replacesTitle}”. You can restore it after.{/if}
      </p>
    </div>
  </div>

  {#if pending}
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-(--solus-container-border) px-3 py-2.5" role="alert">
      <span class="min-w-0 flex-1">Replace “{replacesTitle}” with “{pending.name}”?</span>
      <Button variant="ghost" size="xs" onclick={() => (pending = null)}>Keep it</Button>
      <Button
        size="xs"
        onclick={() => {
          const source = pending;
          pending = null;
          if (source) onGenerate(source);
        }}
      >
        Replace
      </Button>
    </div>
  {/if}

  {#if savedLenses.length > 0}
    <ul class="flex flex-col gap-1" aria-label="Saved lenses">
      {#each savedLenses as lens (lens.id)}
        <li class="flex">
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden rounded-lg px-3 py-2 text-left hover:bg-(--wash-2) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-3"
            {disabled}
            title={disabled ? disabledReason : undefined}
            onclick={() => choose({ savedLensId: lens.id, name: lens.name, prompt: lens.prompt })}
          >
            <span class="w-full truncate font-medium text-foreground">{lens.name || "Untitled lens"}</span>
            <span class="line-clamp-2 w-full text-(--solus-text-tertiary)">{lens.prompt}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-(--solus-text-tertiary)">
      No saved lenses yet. Add them in Settings → Review, or type a prompt below.
    </p>
  {/if}

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
        <Button
          variant="ghost"
          size="xs"
          disabled={!draft.trim()}
          title="Keep this prompt in Settings → Review"
          onclick={() => onSavePrompt(draft.trim())}
        >
          Save as lens
        </Button>
      {/snippet}
    </CommentComposer>
  {/key}
</div>
