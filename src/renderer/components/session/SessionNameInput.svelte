<script lang="ts">
  import { fade } from "svelte/transition";

  interface Props {
    /** The name the row currently shows, offered for editing. */
    value: string;
    /** The row's own type ramp — size, tracking, weight. Editing changes what
     *  the label *is*, never how it is set, so the call site hands over the same
     *  classes its label wears and the glyphs stay on their pixels. */
    class?: string;
    /** Where the field lives. A sidebar `row` gets a bare wash under full-width
     *  text; the breadcrumb `band` gets a self-contained field — a neutral plate
     *  and a soft accent ring — so it reads as an edit box, not a highlight
     *  bleeding across a thin bar. */
    variant?: "row" | "band";
    onCommit: (next: string) => void;
    onCancel: () => void;
  }

  let {
    value,
    class: className = "",
    variant = "row",
    onCommit,
    onCancel,
  }: Props = $props();

  let draft = $state(value);
  let committed = false;

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  /** Blur commits, so the two exits (Enter, click away) agree — but Escape
   *  blurs on its way out and must not land as a second, undoing commit.
   *  A name that came back unchanged, or emptied, is a cancel: neither is worth
   *  a rename round-trip, and an empty one would leave the row unnameable. */
  function commit(): void {
    if (committed) return;
    committed = true;
    const next = draft.trim();
    if (!next || next === value) onCancel();
    else onCommit(next);
  }

  function cancel(): void {
    committed = true;
    onCancel();
  }
</script>

<!-- In place means the label does not move, resize, or change weight when it
     becomes editable — the only new things on screen are a caret and, in a
     sidebar `row`, the wash under the text saying this line is live: a separate
     layer that overflows the line box symmetrically instead of a padded box
     that would push the text off its column. The breadcrumb `band` reads a thin
     bar where a bleeding wash looks like stray highlight, so there it is a
     self-contained plate with a soft accent ring. Either way the input carries
     the row's own type through unchanged. -->
<span
  class="relative flex h-full min-w-0 flex-1 items-center {variant === 'row'
    ? '-ml-[0.3125rem]'
    : 'rounded-md bg-accent px-[0.15625rem] ring-1 ring-inset ring-[color-mix(in_oklch,var(--solus-accent)_38%,transparent)]'}"
>
  {#if variant === "row"}
    <span
      class="pointer-events-none absolute inset-x-0 -inset-y-[0.15625rem] rounded-[0.375rem] bg-(--solus-accent-light)"
      aria-hidden="true"
      in:fade={{ duration: reduceMotion ? 0 : 110 }}
    ></span>
  {/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="relative h-full min-w-0 flex-1 bg-transparent px-[0.3125rem] py-0 text-foreground caret-(--solus-accent) outline-none selection:bg-(--solus-accent-soft) {className}"
    bind:value={draft}
    autofocus
    name="session-name"
    aria-label="Name"
    onfocus={(event) => {
      // Select all so a fresh type replaces the name, but keep the view at the
      // start: a long name scrolled to its tail on open reads as clipped junk.
      event.currentTarget.select();
      event.currentTarget.scrollLeft = 0;
    }}
    onblur={commit}
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        event.currentTarget.blur();
      }
    }}
  />
</span>
