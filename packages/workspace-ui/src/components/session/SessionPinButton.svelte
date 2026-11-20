<script lang="ts">
  import { Pin as PinIcon, PinOff as PinOffIcon } from "@lucide/svelte";

  interface Props {
    isPinned: boolean;
    onToggle: () => void;
  }
  let { isPinned, onToggle }: Props = $props();
</script>

<button
  type="button"
  class="group/pin relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
  aria-label={isPinned ? "Unpin session" : "Pin session"}
  aria-pressed={isPinned}
  title={isPinned ? "Unpin session" : "Pin session"}
  onpointerdown={(event) => event.stopPropagation()}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }}
  onclick={(event) => {
    event.stopPropagation();
    onToggle();
  }}
>
  <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
  <PinIcon
    size={12}
    strokeWidth={1.5}
    class="shrink-0 -rotate-35 {isPinned ? 'group-hover/pin:hidden group-focus-visible/pin:hidden' : ''}"
  />
  {#if isPinned}
    <PinOffIcon size={12} strokeWidth={1.5} class="hidden shrink-0 -rotate-35 group-hover/pin:block group-focus-visible/pin:block" />
  {/if}
</button>
