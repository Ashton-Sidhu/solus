<script lang="ts">
  import { Terminal } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { addWslDistroStore } from "../servers/add-wsl-distro.store.svelte";
  import { hostOnboardingStore } from "../servers/host-onboarding.store.svelte";
  import { Button } from "../ui/button";
  import { Checkbox } from "../ui/checkbox";
  import HostStateIcon from "./HostStateIcon.svelte";
  import type { AddOutcome } from "./add-several.svelte";
  import { openSshAdd } from "./add-machine";
  import type { FoundMachine } from "./lib/discover";

  /** One found machine and the one action that adds it, the same one a drop on
   *  its map card takes. A host that runs Solus opens its stage, which pairs with
   *  no code where it can (a host that trusts this network, then SSH) and asks for
   *  a code last. It also joins the machines added together (`selection`); a WSL
   *  distro installs Solus; an SSH config machine opens the SSH form, filled in. */
  interface Props {
    machine: FoundMachine;
    /** Present when the row can be added with others: its box, and how its add went. */
    selection?: { isChosen: boolean; outcome: AddOutcome | undefined; isLocked: boolean; onToggle: (isChosen: boolean) => void };
  }

  let { machine, selection }: Props = $props();

  function act() {
    if (machine.kind === "wsl") return void addWslDistroStore.add(machine.windowsHostId, machine.distro);
    if (machine.kind === "ssh") return openSshAdd(machine.sshTarget);
    hostOnboardingStore.openForDiscovered(machine.server);
  }
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
  {#if selection}
    <Checkbox
      checked={selection.isChosen}
      disabled={selection.isLocked || selection.outcome?.state === "added"}
      onCheckedChange={(isChosen) => selection.onToggle(isChosen)}
      aria-label="Add {machine.name} with the others"
      class="pointer-coarse:size-5"
    />
  {/if}
  <span class="flex size-4 shrink-0 items-center justify-center text-foreground">
    {#if machine.kind === "ssh"}<Terminal size={16} />{:else}<HostOperatingSystemIcon os={machine.os} size={16} />{/if}
  </span>
  <div class="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
    <p class="truncate text-workspace-chrome font-medium">{machine.name}</p>
    <p class="truncate font-mono text-chrome-dense text-muted-foreground">{machine.detail}</p>
    {#if selection?.outcome?.state === "waiting"}
      <p class="text-chrome-dense text-(--solus-text-secondary)" role="status">Connecting…</p>
    {:else if selection?.outcome?.state === "failed"}
      <p class="text-pretty text-chrome-dense text-(--solus-status-error)" role="alert">{selection.outcome.message}</p>
    {/if}
  </div>
  {#if selection?.outcome?.state === "added"}
    <HostStateIcon state="online" size={15} />
  {:else if selection?.outcome?.state !== "waiting"}
    <Button variant="outline" size="sm" class="shrink-0" disabled={selection?.isLocked} onclick={act}>
      {machine.kind === "wsl" ? "Set up" : machine.kind === "ssh" ? "Add over SSH" : "Connect"}
    </Button>
  {/if}
</div>
