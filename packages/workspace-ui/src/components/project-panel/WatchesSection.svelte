<script lang="ts">
  import {
    Eye as EyeIcon,
    Pause as PauseIcon,
    Play as PlayIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Watch } from "@solus/contracts/watch-types";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { canPauseWatch, watchRail } from "../watches/lib/watch-format";
  import { Button } from "../ui/button";

  interface Props {
    /** The session's watches that have not ended, newest first. */
    watches: Watch[];
  }
  let { watches }: Props = $props();

  const store = getWorkspaceContext().watchesStore;

  let now = $state(Date.now());
  $effect(() => {
    if (!watches.some((watch) => watch.status === "waiting")) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  async function run(watch: Watch, command: "pause" | "resume" | "cancel") {
    try {
      await store[command](watch);
    } catch (cause) {
      toasts.error(cause instanceof Error ? cause.message : "Could not change the watch.");
    }
    requestInputFocus();
  }
</script>

<ul class="m-0 flex list-none flex-col gap-px p-0">
  {#each watches as watch (watch.id)}
    <li class="group flex min-h-[2rem] w-full items-center gap-2 rounded-[0.4375rem] py-[0.3125rem] pr-1 pl-2 transition-colors duration-150 hover:bg-(--solus-surface-hover)">
      <span
        class="inline-flex shrink-0 text-(--solus-text-tertiary) {watch.status === 'paused' ? 'opacity-45' : ''}"
        aria-hidden="true"
      >
        <EyeIcon size={13} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col" title={watch.probe?.command ?? watch.reason}>
        <span class="min-w-0 truncate text-(--solus-text-secondary)">{watch.reason}</span>
        <span class="min-w-0 truncate text-xs tabular-nums text-(--solus-text-tertiary)">{watchRail(watch, now)}</span>
      </span>
      {#if canPauseWatch(watch)}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="shrink-0 text-(--solus-text-tertiary)"
          title="Pause watch"
          aria-label="Pause watch"
          onclick={() => void run(watch, "pause")}
        >
          <PauseIcon size={12} />
        </Button>
      {:else if watch.status === "paused"}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="shrink-0 text-(--solus-text-tertiary)"
          title="Resume watch"
          aria-label="Resume watch"
          onclick={() => void run(watch, "resume")}
        >
          <PlayIcon size={12} />
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        class="shrink-0 text-(--solus-text-tertiary)"
        title="Cancel watch"
        aria-label="Cancel watch"
        onclick={() => void run(watch, "cancel")}
      >
        <XIcon size={12} />
      </Button>
    </li>
  {/each}
</ul>
