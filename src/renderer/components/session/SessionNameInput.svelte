<script lang="ts">
  interface Props {
    /** The name the row currently shows, offered for editing. */
    value: string;
    /** Matches the row's own type so the label doesn't jump on entering edit. */
    class?: string;
    onCommit: (next: string) => void;
    onCancel: () => void;
  }

  let { value, class: className = "", onCommit, onCancel }: Props = $props();

  let draft = $state(value);
  let committed = false;

  /** Blur commits, so the two exits (Enter, click away) agree — but Escape
   *  blurs on its way out and must not land as a second, undoing commit. */
  function commit(): void {
    if (committed) return;
    committed = true;
    onCommit(draft);
  }

  function cancel(): void {
    committed = true;
    onCancel();
  }
</script>

<!-- svelte-ignore a11y_autofocus -->
<input
  class="min-w-0 flex-1 rounded-[0.25rem] border-[0.0625rem] border-(--solus-accent) bg-background px-1 py-0 text-[0.78125rem] text-foreground outline-none {className}"
  bind:value={draft}
  autofocus
  aria-label="Session name"
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
