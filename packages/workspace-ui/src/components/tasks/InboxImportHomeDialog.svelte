<script lang="ts">
  import type { InboxRowLocation } from "./lib/inbox-merge";

  interface Props {
    title: string;
    locations: InboxRowLocation[];
    onChoose: (location: InboxRowLocation) => void;
    onCancel: () => void;
  }

  let { title, locations, onChoose, onCancel }: Props = $props();
  let dialog = $state<HTMLDivElement | null>(null);

  $effect(() => {
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
  });
</script>

<div
  class="fixed inset-0 z-60 grid place-items-center bg-black/35 p-4"
  role="presentation"
  onclick={(event) => event.currentTarget === event.target && onCancel()}
>
  <div
    bind:this={dialog}
    class="w-full max-w-sm rounded-2xl bg-card p-4 text-foreground shadow-2xl ring-1 ring-border"
    role="dialog"
    aria-modal="true"
    aria-labelledby="inbox-home-title"
  >
    <h2 id="inbox-home-title" class="text-sm font-medium">Choose a project</h2>
    <p class="mt-1 text-workspace-chrome text-muted-foreground">
      “{title}” appears through more than one binding. Choose where Solus must create the task.
    </p>
    <div class="mt-3 grid gap-1.5">
      {#each locations as location (`${location.serverId}:${location.projectKey}`)}
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center justify-between rounded-xl border-0 bg-[var(--wash-1)] px-3 py-2 text-left text-workspace-chrome hover:bg-[var(--wash-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onclick={() => onChoose(location)}
        >
          <span class="truncate font-medium">{location.projectLabel}</span>
          <span class="ml-3 truncate text-muted-foreground">{location.serverId}</span>
        </button>
      {/each}
    </div>
    <div class="mt-3 flex justify-end">
      <button
        type="button"
        class="cursor-pointer rounded-lg border-0 px-3 py-1.5 text-workspace-chrome text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground"
        onclick={onCancel}
      >Cancel</button>
    </div>
  </div>
</div>
