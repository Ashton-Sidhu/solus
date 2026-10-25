<script lang="ts">
  import { tick } from "svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import type { DiscoveredServer } from "@solus/contracts/types";
  import { localApi } from "@solus/client-core/local-api";
  import PairingBridge from "./PairingBridge.svelte";
  import { thisDevice, type PairingPhase } from "./lib/pairing-bridge";

  interface Props {
    target: DiscoveredServer;
  }

  let { target }: Props = $props();

  const device = thisDevice(localApi.getPlatform(), navigator.userAgent);
  // The SSH and code forms wait on the person, so the host stands found.
  const phase = $derived<PairingPhase>(
    store.pairingView === "connecting" || store.pairingBusy ? "pairing"
      : store.pairingView === "error" ? "error"
      : "found",
  );

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

<!-- The stage owns the title and the one-line why; this is only the control. -->
<div class="mb-5">
  <PairingBridge {phase} {device} host={{ name: target.name, os: target.os }} />
</div>
<form onsubmit={submit}>
  {#if store.pairingView === "connecting"}
    <!-- The bridge above says it: pairing is running. -->
  {:else if store.pairingView === "error"}
    <p class="cursor-text select-text text-pretty text-destructive">{store.pairingError}</p>
  {:else if store.pairingView === "ssh-target"}
    <label class="block">
      <span class="mb-2 block text-[0.8125rem] text-muted-foreground">SSH address</span>
      <Input
        bind:ref={sshTargetInput}
        bind:value={store.sshTarget}
        disabled={store.pairingBusy}
        class="h-10 rounded-[0.6875rem] px-3.5"
        placeholder="user@host"
        autocomplete="off"
        spellcheck={false}
        dictation={false}
      />
    </label>
    {#if store.pairingError}
      <p class="mt-2.5 text-pretty text-[0.8125rem] text-muted-foreground">{store.pairingError}</p>
    {/if}
  {:else if store.pairingView === "ssh-password"}
    <label class="block">
      <span class="mb-2 block truncate text-[0.8125rem] text-muted-foreground">
        Password or passphrase for {store.sshTarget}
      </span>
      <Input
        bind:ref={sshPasswordInput}
        bind:value={store.sshPassword}
        disabled={store.pairingBusy}
        class="h-10 rounded-[0.6875rem] px-3.5"
        type="password"
        autocomplete="current-password"
        dictation={false}
      />
    </label>
  {:else}
    <label class="block">
      <span class="mb-2 block text-[0.8125rem] text-muted-foreground">Pair code</span>
      <Input
        bind:ref={codeInput}
        bind:value={store.pairCode}
        disabled={store.pairingBusy}
        class="h-10 max-w-[10rem] rounded-[0.6875rem] px-3.5 text-center tracking-[0.2em] tabular-nums"
        placeholder="000000"
        inputmode="numeric"
        maxlength={6}
        autocomplete="one-time-code"
        dictation={false}
      />
    </label>
    {#if store.pairingError}
      <p class="mt-2.5 text-pretty text-[0.8125rem] text-destructive">{store.pairingError}</p>
    {/if}
  {/if}

  <p class="mt-2.5 text-[0.8125rem] text-muted-foreground">
    {#if store.pairingView === "fallback"}
      Have SSH access?
      <Button variant="link" class="h-auto px-0 text-[length:inherit]" onclick={() => void store.startSshBootstrap()}>
        Use SSH
      </Button>
    {:else}
      No SSH?
      <Button variant="link" class="h-auto px-0 text-[length:inherit]" onclick={() => store.useCodeFallback()}>
        Pair with a code
      </Button>
    {/if}
  </p>
  <!-- Submits on Enter; the visible control lives in the stage footer. -->
  <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Continue</button>
</form>
