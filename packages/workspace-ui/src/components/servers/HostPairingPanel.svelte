<script lang="ts">
  import { tick } from "svelte";
  import { InfoIcon } from "phosphor-svelte";
  import { Input } from "../ui/input";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import type { DiscoveredServer } from "@solus/contracts/types";

  interface Props {
    target: DiscoveredServer;
  }

  let { target }: Props = $props();

  let sshTargetInput: HTMLInputElement | null = $state(null);
  let sshPasswordInput: HTMLInputElement | null = $state(null);
  let codeInput: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (store.pairingView === "ssh-target")
      void tick().then(() => sshTargetInput?.focus());
    if (store.pairingView === "ssh-password")
      void tick().then(() => sshPasswordInput?.focus());
    if (store.pairingView === "fallback")
      void tick().then(() => codeInput?.focus());
  });

  // Every form submits the same way the footer's primary does, so Enter and the
  // button are never out of step.
  function submit(event: SubmitEvent) {
    event.preventDefault();
    store.submitCurrentPairingView();
  }
</script>

<p class="text-2xl font-medium text-(--solus-text-primary)">
  {target.name}
</p>
<p
  class="mt-1 truncate text-xs text-(--solus-text-tertiary)"
  style="font-family: 'Geist Mono', ui-monospace, monospace"
>
  {target.host}:{target.port}
  {target.source === "lan" ? " · LAN" : " · Tailnet"}
</p>

<div class="mt-[0.8125rem] flex items-center gap-2.5">
  <span
    class="h-0.5 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--solus-text-primary)_12%,transparent)]"
  >
    {#if store.pairingView === "connecting" || store.pairingBusy}
      <span
        class="block h-full w-2/5 rounded-full bg-(--solus-accent) animate-[connect-progress-slide_1.5s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40"
      ></span>
    {:else if store.pairingView === "error"}
      <span class="block h-full w-full rounded-full bg-(--solus-status-error)/40"></span>
    {/if}
  </span>
  <span class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)">
    {store.pairingView === "error" ? "Not connected" : "Connecting"}
  </span>
</div>

<form onsubmit={submit}>
  {#if store.pairingView === "connecting"}
    <p class="mt-4 text-pretty text-sm leading-[1.6] font-secondary text-(--solus-text-secondary)">
      Solus is using your existing SSH access to install and start the agent on
      {target.name}. Nothing is installed on this Mac.
    </p>
  {:else if store.pairingView === "error"}
    <p class="mt-4 text-pretty text-sm leading-[1.6] text-(--solus-status-error)">
      {store.pairingError}
    </p>
  {:else if store.pairingView === "ssh-target"}
    <p
      class="mt-4 flex items-start gap-2 text-pretty text-xs leading-[1.55] font-secondary text-(--solus-text-secondary)"
    >
      <InfoIcon size={14} class="mt-[0.1875rem] shrink-0 text-(--solus-text-quaternary)" />
      <span>
        {store.pairingError ||
          `Solus connects over your existing SSH access to set up ${target.name}.`}
      </span>
    </p>
    <label class="mt-3.5 block">
      <span
        class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
        >SSH target</span
      >
      <Input
        bind:ref={sshTargetInput}
        bind:value={store.sshTarget}
        disabled={store.pairingBusy}
        class="mt-1.5 h-10 w-full rounded-lg border-(--solus-input-border) px-3 text-sm text-(--solus-text-primary) transition-[border-color,box-shadow] duration-150 placeholder:text-(--solus-text-quaternary) focus-visible:border-(--solus-input-focus-border) focus-visible:ring-[3px] focus-visible:ring-(--solus-input-focus-ring) md:text-sm"
        placeholder="user@host"
        autocomplete="off"
        spellcheck={false}
      />
    </label>
  {:else if store.pairingView === "ssh-password"}
    <p
      class="mt-4 flex items-start gap-2 text-pretty text-xs leading-[1.55] font-secondary text-(--solus-text-secondary)"
    >
      <InfoIcon size={14} class="mt-[0.1875rem] shrink-0 text-(--solus-text-quaternary)" />
      <span>
        Enter the SSH password or key passphrase for
        <span
          class="rounded-md bg-(--solus-surface-hover) px-1 py-0.5 text-xs text-(--solus-text-primary)"
          >{store.sshTarget}</span
        >. It is used once and never stored.
      </span>
    </p>
    <label class="mt-3.5 block">
      <span
        class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
        >Password or passphrase</span
      >
      <Input
        bind:ref={sshPasswordInput}
        bind:value={store.sshPassword}
        disabled={store.pairingBusy}
        class="mt-1.5 h-10 w-full rounded-lg border-(--solus-input-border) px-3 text-sm text-(--solus-text-primary) transition-[border-color,box-shadow] duration-150 placeholder:text-(--solus-text-quaternary) focus-visible:border-(--solus-input-focus-border) focus-visible:ring-[3px] focus-visible:ring-(--solus-input-focus-ring) md:text-sm"
        type="password"
        placeholder="••••••••"
        autocomplete="current-password"
      />
    </label>
  {:else}
    <p
      class="mt-4 flex items-start gap-2 text-pretty text-xs leading-[1.55] font-secondary text-(--solus-text-secondary)"
    >
      <InfoIcon size={14} class="mt-[0.1875rem] shrink-0 text-(--solus-text-quaternary)" />
      <span>
        Use the one-time code only for web, mobile, or environments without SSH.
      </span>
    </p>
    <label class="mt-3.5 block">
      <span
        class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
        >{target.claimable ? "Claim code" : "Pair code"}</span
      >
      <Input
        bind:ref={codeInput}
        bind:value={store.pairCode}
        disabled={store.pairingBusy}
        class="mt-1.5 h-10 w-full max-w-[12rem] rounded-lg border-(--solus-input-border) px-3 text-center text-sm tabular-nums text-(--solus-text-primary) transition-[border-color,box-shadow] duration-150 placeholder:text-(--solus-text-quaternary) focus-visible:border-(--solus-input-focus-border) focus-visible:ring-[3px] focus-visible:ring-(--solus-input-focus-ring) md:text-sm"
        placeholder="000000"
        inputmode="numeric"
        maxlength="6"
        autocomplete="one-time-code"
      />
    </label>
    {#if store.pairingError}
      <p class="mt-2 text-pretty text-xs leading-relaxed text-(--solus-status-error)">
        {store.pairingError}
      </p>
    {/if}
  {/if}
  <!-- Submits on Enter; the visible control lives in the stage footer. -->
  <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Continue</button>
</form>
