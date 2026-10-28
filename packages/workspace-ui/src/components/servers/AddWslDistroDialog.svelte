<script lang="ts">
  /** "Add a WSL distro" (docs/plans/windows.md §13.6). The flow lives in
   *  `addWslDistroStore`; this is the distro choice, the live progress, and the result. */
  import { tick } from "svelte";
  import { Check as CheckIcon, LoaderCircle as LoaderIcon, X as XIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import * as Select from "../ui/select";
  import { addWslDistroStore as store } from "./add-wsl-distro.store.svelte";

  let addButton = $state<HTMLElement | null>(null);
  let doneButton = $state<HTMLElement | null>(null);

  const isRunning = $derived(store.phase === "running");

  // Add takes the focus once the distros are read, and Done once the distro is added.
  $effect(() => {
    if (!store.isOpen) return;
    if (store.phase === "done") void tick().then(() => doneButton?.focus());
    else if (store.phase === "form") void tick().then(() => addButton?.focus());
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void store.submit();
  }

  function handleBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget && !isRunning) store.close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      store.close();
    }
  }
</script>

{#if store.isOpen}
  <div
    class="fixed inset-0 z-[10025] flex items-start justify-center px-4 pt-[10vh] pointer-events-auto picker-backdrop"
    role="presentation"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-wsl-distro-title"
      class="w-full max-w-[28rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow)"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="add-wsl-distro-title" class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
            Add a WSL distro
          </h2>
          <p class="mt-0.5 truncate text-chrome-dense text-(--solus-text-tertiary)">
            {store.windowsHostName} installs Solus in the distro and reaches it there.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onclick={() => store.close()}>
          <XIcon size={16} />
        </Button>
      </header>

      {#if store.phase === "done"}
        <div class="flex flex-col gap-4 px-4 py-4">
          <p class="flex items-start gap-2 text-pretty text-workspace-chrome text-(--solus-text-primary)">
            <CheckIcon size={16} class="mt-0.5 shrink-0 text-(--solus-status-complete)" />
            <span class="cursor-text select-text">{store.resultMessage}</span>
          </p>
          <div class="flex justify-end">
            <Button bind:ref={doneButton} onclick={() => store.close()}>Done</Button>
          </div>
        </div>
      {:else}
        <form class="flex flex-col gap-4 px-4 py-4" onsubmit={submit}>
          {#if store.phase === "loading"}
            <p class="flex items-center gap-2 text-chrome-dense text-(--solus-text-tertiary)" aria-live="polite">
              <LoaderIcon size={13} class="shrink-0 animate-spin motion-reduce:animate-none" />
              Reading the WSL distros…
            </p>
          {:else if store.distros.length > 0}
            <div class="block">
              <span class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">Distro</span>
              <Select.Root type="single" value={store.distro} onValueChange={(next) => (store.distro = next)} disabled={isRunning}>
                <Select.Trigger aria-label="Distro" class="w-full">
                  <span class="truncate">{store.distro}</span>
                </Select.Trigger>
                <Select.Content class="z-[10030]">
                  {#each store.distros as distro (distro.name)}
                    <Select.Item value={distro.name} label={distro.name}>
                      {#snippet children()}
                        <span class="min-w-0 flex-1 truncate">{distro.name}</span>
                        <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">
                          {distro.isDefault ? "Default · " : ""}WSL {distro.version}
                        </span>
                      {/snippet}
                    </Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              <span class="mt-1 block text-pretty text-chrome-dense text-(--solus-text-tertiary)">
                Solus installs its own Linux release there, so the distro needs nothing installed. Only {store.windowsHostName} reaches it.
              </span>
            </div>
          {/if}

          {#if store.progress.length > 0}
            <ol class="flex flex-col gap-1" aria-live="polite">
              {#each store.progress as step, index (index)}
                {@const isCurrent = isRunning && index === store.progress.length - 1}
                <li class="flex items-center gap-2 text-chrome-dense {isCurrent ? 'text-(--solus-text-primary)' : 'text-(--solus-text-tertiary)'}">
                  {#if isCurrent}
                    <LoaderIcon size={13} class="shrink-0 animate-spin motion-reduce:animate-none" />
                  {:else}
                    <CheckIcon size={13} class="shrink-0" />
                  {/if}
                  <span class="min-w-0 truncate">{step.message}</span>
                </li>
              {/each}
            </ol>
          {/if}

          {#if store.error}
            <p class="cursor-text select-text text-pretty text-chrome-dense text-destructive" role="alert">{store.error}</p>
          {/if}

          <div class="flex justify-end gap-2">
            <Button variant="ghost" onclick={() => store.close()}>Cancel</Button>
            <Button bind:ref={addButton} type="submit" disabled={!store.canSubmit}>
              {#if isRunning}
                <LoaderIcon size={14} class="animate-spin motion-reduce:animate-none" />
                Adding…
              {:else}
                Add distro
              {/if}
            </Button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
