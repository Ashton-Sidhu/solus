<script lang="ts">
  /** "Add a machine over SSH": a machine that was not found on the network
   *  (docs/plans/host-routes.md D6). The flow and its decisions live in
   *  `addOverSshStore`; this is the form, the live progress, and the result. */
  import { tick } from "svelte";
  import { Check as CheckIcon, LoaderCircle as LoaderIcon, X as XIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import { addOverSshStore as store } from "./add-over-ssh.store.svelte";

  let targetInput: HTMLInputElement | null = $state(null);
  let passwordInput: HTMLInputElement | null = $state(null);
  let doneButton = $state<HTMLElement | null>(null);

  const isRunning = $derived(store.phase === "running");

  // The next thing to type gets the focus: the target on open, the password
  // when SSH asks for it, and Done once the machine is added.
  $effect(() => {
    if (!store.isOpen) return;
    if (store.phase === "done") void tick().then(() => doneButton?.focus());
    else if (store.phase === "form") {
      const field = store.isPasswordRequested ? passwordInput : targetInput;
      void tick().then(() => field?.focus());
    }
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
      aria-labelledby="add-over-ssh-title"
      class="w-full max-w-[28rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow)"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="add-over-ssh-title" class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
            Add a machine over SSH
          </h2>
          <p class="mt-0.5 truncate text-chrome-dense text-(--solus-text-tertiary)">
            {store.sshHostName} signs in with its SSH keys and installs Solus there.
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
          <label class="block">
            <span class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">SSH target</span>
            <Input
              bind:ref={targetInput}
              bind:value={store.sshTarget}
              disabled={isRunning}
              placeholder="user@host or an alias"
              autocomplete="off"
              spellcheck={false}
              dictation={false}
            />
          </label>

          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-workspace-chrome text-(--solus-text-primary)">Link to my Solus account</p>
              <p class="mt-0.5 text-pretty text-chrome-dense text-(--solus-text-tertiary)">
                {#if store.canLink}
                  Reach it from every device through your account. Off: only {store.sshHostName} reaches it, over SSH.
                {:else}
                  Sign in to Solus Cloud to link it. Without a link, only {store.sshHostName} reaches it, over SSH.
                {/if}
              </p>
            </div>
            <Switch
              checked={store.linkToAccount}
              onCheckedChange={(next) => store.setLinkToAccount(next)}
              disabled={isRunning || !store.canLink}
              aria-label="Link to my Solus account"
            />
          </div>

          {#if store.linkToAccount}
            <label class="block">
              <span class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">
                Password {store.isPasswordRequested ? "" : "(only if it has no SSH key)"}
              </span>
              <Input
                bind:ref={passwordInput}
                bind:value={store.password}
                disabled={isRunning}
                type="password"
                autocomplete="current-password"
                dictation={false}
              />
              <span class="mt-1 block text-chrome-dense text-(--solus-text-tertiary)">Used once and never stored.</span>
            </label>
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
            <Button type="submit" disabled={!store.canSubmit}>
              {#if isRunning}
                <LoaderIcon size={14} class="animate-spin motion-reduce:animate-none" />
                Adding…
              {:else}
                Add machine
              {/if}
            </Button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
