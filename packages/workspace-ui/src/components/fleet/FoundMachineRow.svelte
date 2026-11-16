<script lang="ts">
  import { tick } from "svelte";
  import { Terminal } from "@lucide/svelte";
  import { discoveredServerUrl } from "../../contexts";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { addWslDistroStore } from "../servers/add-wsl-distro.store.svelte";
  import { hostOnboardingStore } from "../servers/host-onboarding.store.svelte";
  import { messageFor } from "../servers/lib/setup-rpc";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { openSshAdd, pairWithCode } from "./add-machine";
  import type { FoundMachine } from "./lib/discover";

  /** One found machine and the one action that adds it (D7, D8). A host that runs
   *  Solus pairs in this row with the code it shows; a WSL distro installs Solus;
   *  an SSH config machine opens the SSH form, filled in. */
  interface Props {
    machine: FoundMachine;
  }

  let { machine }: Props = $props();

  let isEnteringCode = $state(false);
  let code = $state("");
  let phase = $state<"idle" | "pairing" | "paired">("idle");
  let error = $state<string | null>(null);
  let codeInput = $state<HTMLInputElement | null>(null);

  async function act() {
    if (machine.kind === "wsl") return void addWslDistroStore.add(machine.windowsHostId, machine.distro);
    if (machine.kind === "ssh") return openSshAdd(machine.sshTarget);
    isEnteringCode = true;
    await tick();
    codeInput?.focus();
  }

  async function pair() {
    if (machine.kind !== "server" || code.length !== 6 || phase === "pairing") return;
    phase = "pairing";
    error = null;
    try {
      await pairWithCode(discoveredServerUrl(machine.server), code, machine.server.name, machine.server.source === "tailnet");
      phase = "paired";
    } catch (err) {
      error = messageFor(err);
      phase = "idle";
    }
  }
</script>

<div class="flex flex-col">
  <div class="flex items-center gap-3 px-4 py-3.5">
    <span class="flex size-4 shrink-0 items-center justify-center text-foreground">
      {#if machine.kind === "ssh"}<Terminal size={16} />{:else}<HostOperatingSystemIcon os={machine.os} size={16} />{/if}
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <p class="truncate text-workspace-chrome font-medium">{machine.name}</p>
      <p class="truncate font-mono text-chrome-dense text-muted-foreground">{machine.detail}</p>
    </div>
    {#if phase === "paired"}
      <HostStateIcon state="online" size={15} />
    {:else if !isEnteringCode}
      <Button variant="outline" size="sm" class="shrink-0" onclick={act}>
        {machine.kind === "wsl" ? "Set up" : machine.kind === "ssh" ? "Add over SSH" : "Connect"}
      </Button>
    {/if}
  </div>
  {#if isEnteringCode && machine.kind === "server" && phase !== "paired"}
    <form class="flex flex-wrap items-center gap-3 px-4 pb-4 pl-11" onsubmit={(event) => { event.preventDefault(); void pair(); }}>
      <p class="min-w-0 flex-1 basis-56 text-[0.8125rem] text-pretty text-(--solus-text-secondary)">
        Enter the code {machine.name} shows in Settings › Hosts › This device › Access.
      </p>
      <input
        bind:this={codeInput}
        bind:value={code}
        oninput={() => (code = code.replace(/\D/g, "").slice(0, 6))}
        name="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="000000"
        aria-label="Code from {machine.name}"
        class="h-8 w-[7.5rem] rounded-lg border border-border/60 bg-background px-2.5 font-mono text-[0.9375rem] tracking-[0.35em] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-(--solus-status-running)/50 max-sm:text-base"
      />
      <Button type="submit" size="sm" disabled={code.length !== 6 || phase === "pairing"}>{phase === "pairing" ? "Pairing…" : "Pair"}</Button>
      <Button variant="ghost" size="sm" onclick={() => hostOnboardingStore.openForDiscovered(machine.server)}>Use SSH</Button>
      {#if error}<p class="w-full text-chrome-dense text-(--solus-status-error)" role="alert">{error}</p>{/if}
    </form>
  {/if}
</div>
