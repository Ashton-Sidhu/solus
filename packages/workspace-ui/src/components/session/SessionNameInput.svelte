<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    committedRenameValue,
    focusRenameInputText,
  } from "../../lib/rename-input";

  interface Props {
    /** The name the row currently shows, offered for editing. */
    value: string;
    /** The row's own type ramp — size, tracking, weight. Editing changes what
     *  the label *is*, never how it is set, so the call site hands over the same
     *  classes its label wears and the glyphs stay on their pixels. */
    class?: string;
    /** Where the field lives. A sidebar `row` edits the bare text in place; the
     *  breadcrumb `band` gets a self-contained field — a neutral plate and a
     *  neutral ring — so it reads as an edit box on a thin bar. */
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

  let draft = $state(untrack(() => value));
  let committed = false;
  let input = $state<HTMLInputElement | null>(null);

  onMount(() => {
    // Context-menu teardown restores focus to its trigger. Wait until that
    // completes, then make the rename field the final focus owner. Otherwise
    // the resulting blur cancels the edit before the user can type.
    const frame = requestAnimationFrame(() => {
      if (input) focusRenameInputText(input);
    });
    return () => cancelAnimationFrame(frame);
  });

  /** Blur commits, so the two exits (Enter, click away) agree — but Escape
   *  blurs on its way out and must not land as a second, undoing commit.
   *  A name that came back unchanged, or emptied, is a cancel: neither is worth
   *  a rename round-trip, and an empty one would leave the row unnameable. */
  function commit(): void {
    if (committed) return;
    committed = true;
    const next = committedRenameValue(draft, value);
    if (next === null) onCancel();
    else onCommit(next);
  }

  function cancel(): void {
    committed = true;
    onCancel();
  }
</script>

<!-- In place means the label does not move, resize, or change weight when it
     becomes editable — in a sidebar `row` the only new things on screen are a
     caret and the host OS selection highlight. The breadcrumb `band` is a thin
     bar, so there the field is a self-contained neutral plate that reads as an
     edit box. Either way the input carries the row's own type through
     unchanged. -->
<span
  class="relative flex h-full min-w-0 flex-1 items-center {variant === 'row'
    ? '-ml-[0.3125rem]'
    : 'rounded-md bg-accent px-[0.15625rem] ring-1 ring-inset ring-border'}"
>
  <input
    bind:this={input}
    class="relative h-full min-w-0 flex-1 bg-transparent px-[0.3125rem] py-0 text-foreground caret-(--solus-accent) outline-none selection:bg-[color:Highlight] {className}"
    bind:value={draft}
    name="session-name"
    aria-label="Name"
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
