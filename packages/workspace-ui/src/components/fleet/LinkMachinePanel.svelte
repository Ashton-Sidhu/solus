<script lang="ts">
  import { onDestroy } from "svelte";
  import { Check, Copy } from "@lucide/svelte";
  import { hostLinkCommand, windowsHostLinkCommand } from "../onboarding/lib/host-link-command";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { linkMachineStore } from "./link-machine.store.svelte";

  /** "Link a machine you own" (D8): one command for the machine's system, a copy
   *  button, and a wait that ends when the machine appears. */
  let system = $state<"unix" | "windows">("unix");
  let hasCopied = $state(false);

  const ticket = $derived(linkMachineStore.ticket);
  const command = $derived(ticket ? (system === "unix" ? hostLinkCommand(ticket) : windowsHostLinkCommand(ticket)) : null);

  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      hasCopied = true;
    } catch {
      hasCopied = false;
    }
  }

  // The wait belongs to this panel: leaving the page stops reading the directory.
  onDestroy(() => linkMachineStore.stop());
</script>

{#if !linkMachineStore.isAvailable}
  <p class="text-[0.8125rem] text-(--solus-text-secondary)">Sign in to Solus to link a machine to your account.</p>
{:else if linkMachineStore.linkedLabel}
  <p class="flex items-center gap-2 text-[0.8125rem]"><HostStateIcon state="online" size={14} />{linkMachineStore.linkedLabel} is linked and on your map.</p>
{:else if !command}
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-[0.8125rem] text-(--solus-text-secondary)">Solus makes a one-time code for your account. It ends in ten minutes.</p>
    <Button size="sm" onclick={() => void linkMachineStore.request()}>Get the command</Button>
  </div>
  {#if linkMachineStore.error}<p class="text-chrome-dense text-(--solus-status-error)" role="alert">{linkMachineStore.error}</p>{/if}
{:else}
  <div class="flex flex-col gap-3">
    <div class="flex gap-1" role="radiogroup" aria-label="System of the machine">
      {#each [["unix", "macOS and Linux"], ["windows", "Windows"]] as const as [value, label] (value)}
        <button
          type="button"
          role="radio"
          aria-checked={system === value}
          onclick={() => { system = value; hasCopied = false; }}
          class="inline-flex h-[1.625rem] items-center rounded-full px-2.5 text-[0.8125rem] text-muted-foreground hover:bg-(--wash-1) hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
        >{label}</button>
      {/each}
    </div>
    <div class="flex items-center gap-2 rounded-lg bg-(--wash-2) py-1.5 pr-1.5 pl-3">
      <code class="min-w-0 flex-1 truncate font-mono text-chrome-dense select-all">{command}</code>
      <Button variant="ghost" size="sm" onclick={copy}>
        {#if hasCopied}<Check size={13} />Copied{:else}<Copy size={13} />Copy{/if}
      </Button>
    </div>
    <p class="text-[0.8125rem] {linkMachineStore.isWaiting ? 'text-(--solus-status-running)' : 'text-muted-foreground'}">
      {linkMachineStore.isWaiting ? "Waiting for the machine. Keep this page open, or come back later." : "The code ended. Get a new command to try again."}
    </p>
  </div>
{/if}
