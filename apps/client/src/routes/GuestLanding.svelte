<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowRight as ArrowRightIcon, Link2Off as LinkOffIcon } from "@lucide/svelte";
  import { Button } from "@solus/workspace-ui/components/ui/button";
  import { Label } from "@solus/workspace-ui/components/ui/label";
  import WorkspaceMark from "@solus/workspace-ui/components/ui/WorkspaceMark.svelte";
  import { guestBoot } from "../lib/guest-boot.svelte";

  /**
   * Where a share link lands (docs/plans/multiplayer-sharing.md §4.2): the visitor
   * has no account and needs none. One question — the name other people see —
   * then the host decides whether the link still opens anything.
   */
  interface Props {
    onContinue: (displayName: string) => void;
  }
  let { onContinue }: Props = $props();

  let nameInput = $state(guestBoot.displayName);
  let nameInputEl: HTMLInputElement | null = $state(null);
  const busy = $derived(guestBoot.phase === "connecting");
  const name = $derived(nameInput.trim());

  onMount(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) nameInputEl?.focus();
  });

  function submit(event: Event) {
    event.preventDefault();
    if (busy || !name) return;
    onContinue(name);
  }
</script>

<!-- The app's own door: the mark and the word above one card, on the same
     background the workspace has, so the page a guest lands on is already
     Solus and not a form in front of it. -->
<div
  class="text-workspace-chrome flex min-h-dvh w-full flex-col items-center justify-center gap-8 overflow-y-auto bg-(--background) px-5 pt-[max(2.5rem,env(safe-area-inset-top,0px))] pb-[max(2.5rem,env(safe-area-inset-bottom,0px))]"
  data-solus-ui
>
  <header class="flex max-w-[26rem] flex-col items-center gap-4 text-center">
    <span class="flex items-center gap-2 font-medium tracking-[-0.01em] text-(--solus-text-primary)">
      {#if guestBoot.phase === "revoked"}
        <span class="flex size-9 items-center justify-center rounded-xl bg-(--solus-surface-hover) text-(--solus-text-secondary)">
          <LinkOffIcon size={16} />
        </span>
      {:else}
        <WorkspaceMark class="size-9" />
      {/if}
    </span>
    <h1 class="text-pretty text-2xl font-medium leading-[1.25] tracking-[-0.015em] text-(--solus-text-primary)">
      {guestBoot.phase === "revoked" ? "This link no longer works" : "You’ve been invited to Solus"}
    </h1>
    <p class="text-pretty leading-relaxed text-(--solus-text-tertiary)">
      {#if guestBoot.phase === "revoked"}
        The person who shared it turned the link off or made a new one. Ask them for the current link.
      {:else}
        Someone shared their work with you. Pick the name they will see, and you are in. No account needed.
      {/if}
    </p>
  </header>

  {#if guestBoot.phase !== "revoked"}
    <main class="flex w-full max-w-[24rem] flex-col gap-4">
      <form
        class="flex flex-col gap-4 rounded-2xl border border-(--solus-container-border) bg-(--solus-popover-bg) p-5 shadow-[shadow:var(--solus-popover-shadow)]"
        onsubmit={submit}
      >
        <div class="flex flex-col gap-2">
          <Label for="guest-display-name" class="text-(--solus-text-secondary)">Your name</Label>
          <!-- A plain field, not the Input primitive: that one wires dictation
               through the app core's voice store, and this page mounts before
               any app core exists. -->
          <input
            bind:this={nameInputEl}
            bind:value={nameInput}
            id="guest-display-name"
            type="text"
            class="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-(--solus-text-primary) outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="How should we call you?"
            maxlength="80"
            autocomplete="name"
            spellcheck="false"
            disabled={busy}
            data-testid="guest-name"
          />
        </div>

        {#if guestBoot.phase === "failed" && guestBoot.error}
          <p class="text-pretty leading-relaxed text-(--solus-status-error)" role="alert" data-testid="guest-error">{guestBoot.error}</p>
        {/if}

        <Button type="submit" size="lg" class="w-full" disabled={busy || !name} data-testid="guest-continue">
          {busy ? "Connecting…" : guestBoot.phase === "failed" ? "Try again" : "Continue"}
          {#if !busy}<ArrowRightIcon data-icon="inline-end" />{/if}
        </Button>
      </form>
      <p class="px-1 text-center text-[0.875em] leading-relaxed text-(--solus-text-tertiary)">
        Your visit is limited to what was shared. The link stops working when its owner turns it off.
      </p>
    </main>
  {/if}

  <footer class="flex items-center gap-1.5 text-[0.875em] text-(--solus-text-tertiary)">
    <WorkspaceMark class="size-3.5" />
    <span>Solus · a workspace for coding agents</span>
  </footer>
</div>
