<script lang="ts">
  /** The add of a WSL distro in the add-host dialog (docs/plans/windows.md
   *  §5.13): the live progress, the result, and the link to the account. The
   *  distro was chosen in the nearby list; the flow lives in `addWslDistroStore`. */
  import { tick } from "svelte";
  import { Link2 as LinkIcon, LoaderCircle as LoaderIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import StatusCard from "../conversation/StatusCard.svelte";
  import { addWslDistroStore as store } from "./add-wsl-distro.store.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let closeButton = $state<HTMLElement | null>(null);
  let doneButton = $state<HTMLElement | null>(null);
  let retryButton = $state<HTMLElement | null>(null);

  // The next action takes the focus: Close while the add runs, Try again after a failure, Done at the end.
  $effect(() => {
    const next = store.phase === "done" ? doneButton : store.phase === "failed" ? retryButton : closeButton;
    void tick().then(() => next?.focus());
  });
</script>

<div class="flex flex-col gap-4">
  {#if store.statusCard}
    <!-- The same card a run's setup draws; its last step is the result. -->
    <StatusCard card={store.statusCard} keepsStepsOpen />
  {/if}

  {#if store.phase === "done" && store.error}
    <p class="cursor-text select-text text-pretty text-chrome-dense text-destructive" role="alert">{store.error}</p>
  {/if}

  <div class="flex items-center justify-end gap-2">
    {#if store.phase === "running"}
      <!-- Closing does not stop the add: the host finishes it, and the distro is saved. -->
      <span class="mr-auto text-chrome-dense text-(--solus-text-tertiary)">You can close this; the add goes on.</span>
      <Button bind:ref={closeButton} variant="ghost" onclick={() => onclose()}>Close</Button>
      <Button disabled>
        <LoaderIcon size={14} class="animate-spin motion-reduce:animate-none" />
        Adding…
      </Button>
    {:else if store.phase === "failed"}
      <Button variant="ghost" onclick={() => onclose()}>Cancel</Button>
      <Button bind:ref={retryButton} onclick={() => store.retry()}>Try again</Button>
    {:else}
      {#if store.canLink}
        <Button variant="outline" disabled={store.isLinking} onclick={() => void store.link()}>
          <LinkIcon size={14} />
          {store.isLinking ? "Linking…" : "Link to my account"}
        </Button>
      {/if}
      <Button bind:ref={doneButton} onclick={() => onclose()}>Done</Button>
    {/if}
  </div>
</div>
