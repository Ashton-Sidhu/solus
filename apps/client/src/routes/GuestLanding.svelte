<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowRight as ArrowRightIcon, Users as UsersIcon } from "@lucide/svelte";
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

<!-- Same posture as the hostless home: one headline, then the one thing this
     screen exists for. -->
<div
  class="text-sm flex min-h-dvh w-full flex-col items-center justify-center gap-8 overflow-y-auto bg-(--solus-bg) px-5 py-10"
  data-solus-ui
>
  <header class="flex max-w-[26rem] flex-col items-center gap-3 text-center">
    <span class="flex size-10 items-center justify-center rounded-full bg-(--solus-accent-light) text-(--solus-accent)">
      <UsersIcon size={18} />
    </span>
    <h1 class="text-pretty text-2xl font-medium leading-[1.25] text-(--solus-text-primary)">
      {guestBoot.phase === "revoked" ? "This link no longer works" : "You’ve been invited to Solus"}
    </h1>
    <p class="leading-relaxed text-(--solus-text-tertiary)">
      {#if guestBoot.phase === "revoked"}
        The person who shared it turned the link off or made a new one. Ask them for the current link.
      {:else}
        Someone shared a session or a document with you. Pick the name they will see, and you are in. No account needed.
      {/if}
    </p>
  </header>

  {#if guestBoot.phase !== "revoked"}
    <main class="flex w-full max-w-[26rem] flex-col gap-4">
      <form
        class="flex flex-col gap-2.5 rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-3"
        onsubmit={submit}
      >
        <label class="block">
          <span class="text-xs font-medium text-(--solus-text-secondary)">Your name</span>
          <input
            bind:this={nameInputEl}
            bind:value={nameInput}
            type="text"
            class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
            placeholder="How should we call you?"
            maxlength="80"
            autocomplete="name"
            spellcheck="false"
            disabled={busy}
            data-testid="guest-name"
          />
        </label>

        {#if guestBoot.phase === "failed" && guestBoot.error}
          <p class="text-pretty leading-relaxed text-(--solus-status-error)" role="alert" data-testid="guest-error">{guestBoot.error}</p>
        {/if}

        <button
          type="submit"
          disabled={busy || !name}
          class="inline-flex items-center justify-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2 font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
          data-testid="guest-continue"
        >
          {busy ? "Connecting…" : guestBoot.phase === "failed" ? "Try again" : "Continue"}
          {#if !busy}<ArrowRightIcon size={14} />{/if}
        </button>
      </form>
      <p class="px-1 text-center text-xs leading-relaxed text-(--solus-text-quaternary)">
        Your visit is limited to what was shared. The link stops working when its owner turns it off.
      </p>
    </main>
  {/if}
</div>
