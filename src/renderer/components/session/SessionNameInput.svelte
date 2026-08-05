<script lang="ts">
  import { fade } from "svelte/transition";

  interface Props {
    /** The name the row currently shows, offered for editing. */
    value: string;
    /** The row's own type ramp — size, tracking, weight. Editing changes what
     *  the label *is*, never how it is set, so the call site hands over the same
     *  classes its label wears and the glyphs stay on their pixels. */
    class?: string;
    onCommit: (next: string) => void;
    onCancel: () => void;
  }

  let { value, class: className = "", onCommit, onCancel }: Props = $props();

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
     becomes editable — the only new things on screen are a caret and the wash
     under the text saying this line is live. So: no border, no plate, no field
     of its own; the wash is a separate layer that overflows the line box
     symmetrically instead of a padded box that would push the text off its
     column, and the input carries the row's own type through unchanged. -->
<span class="relative -ml-[0.3125rem] flex h-full min-w-0 flex-1 items-center">
  <span
    class="pointer-events-none absolute inset-x-0 -inset-y-[0.15625rem] rounded-[0.375rem] bg-(--solus-accent-light)"
    aria-hidden="true"
    in:fade={{ duration: reduceMotion ? 0 : 110 }}
  ></span>
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="relative h-full min-w-0 flex-1 bg-transparent px-[0.3125rem] py-0 text-foreground caret-(--solus-accent) outline-none selection:bg-(--solus-accent-soft) {className}"
    bind:value={draft}
    autofocus
    aria-label="Name"
    onfocus={(event) => event.currentTarget.select()}
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
