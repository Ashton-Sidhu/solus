<script lang="ts">
  /** What stands between a person and the steps of "Use Solus in other apps"
   *  (`resolveOutsideAppGate`): checking, a host with no Solus account, a
   *  public address that is off, and a host or address that does not answer. */
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { accountStore, uplinkStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { hostLock } from "../../settings/policy/managed-setting.svelte";
  import ManagedSettingNote from "../../settings/policy/ManagedSettingNote.svelte";
  import { registerWay, turnOnWay, type OutsideAppGate } from "../lib/outside-apps-gate";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    gate: Exclude<OutsideAppGate, { kind: "open" }>;
  }

  let { serverId, hostName, gate }: Props = $props();

  const busy = $derived(uplinkStore.busyServerId === serverId);
  const lock = $derived(hostLock(serverId, "cloudTunnel"));
  const host = $derived(hosts.get(serverId));
  const turnOn = $derived(turnOnWay({
    hostKind: host.serverInfo.state === "ready" ? host.serverInfo.value.hostKind : undefined,
    control: uplinkStore.controlFor(serverId),
    mayReachLocally: host.me.may("host.local.reach"),
    locked: !!lock,
  }));
  const register = $derived(registerWay({
    control: uplinkStore.controlFor(serverId),
    accountAvailable: uplinkStore.accountAvailable,
    canLink: uplinkStore.canLink,
  }));

  // Only the kind: a new gate object on each read would run the check again and again.
  const gateKind = $derived(gate.kind);
  // A person who signs in here comes back to a host that the owner's client now registers by itself.
  $effect(() => {
    if (gateKind !== "not-registered" || !uplinkStore.canLink) return;
    void outsideAppsDialog.check(serverId);
  });
</script>

{#snippet checkAgain()}
  <div>
    <Button variant="outline" size="sm" onclick={() => void outsideAppsDialog.check(serverId)}>Check again</Button>
  </div>
{/snippet}

<section class="flex flex-col gap-3" aria-live="polite">
  {#if gate.kind === "checking"}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-(--solus-text-secondary)">
      <SpinnerIcon size={16} class="motion-safe:animate-spin" />
      Checking {hostName}…
    </p>
  {:else if gate.kind === "not-registered"}
    <h3 class="text-base font-medium text-(--solus-text-primary)">Register {hostName} to your Solus account</h3>
    <div class="flex flex-col gap-1 text-workspace-chrome text-(--solus-text-secondary)">
      <p>Apps like Claude and ChatGPT run in the cloud. They need a public address to reach {hostName}.</p>
      <p>A host registered to your account gets that address. Each app still needs your approval.</p>
    </div>
    {#if register === "register"}
      <div>
        <Button size="sm" disabled={busy} onclick={() => void outsideAppsDialog.register(serverId)}>
          {busy ? "Registering…" : "Register"}
        </Button>
      </div>
    {:else if register === "sign-in"}
      <div>
        {#if accountStore.state.kind === "signing-in"}
          <Button variant="outline" size="sm" onclick={() => accountStore.cancelSignIn()}>Cancel sign-in</Button>
        {:else}
          <Button size="sm" disabled={accountStore.state.kind === "unavailable"} onclick={() => void accountStore.signIn()}>Sign in</Button>
        {/if}
      </div>
    {:else}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">Open Solus on {hostName}, or from your Solus Cloud account, and register {hostName} in Settings › Hosts › {hostName} › Access.</p>
      {@render checkAgain()}
    {/if}
  {:else if gate.kind === "turn-on"}
    <h3 class="text-base font-medium text-(--solus-text-primary)">
      {turnOn === "here" ? `Turn on the public address of ${hostName}` : `Turn on the public address on ${hostName}`}
    </h3>
    <div class="flex flex-col gap-1 text-workspace-chrome text-(--solus-text-secondary)">
      <p>{hostName} gets a public https address through Solus Cloud, with no router setup.</p>
      <p>Only apps you approve can use it. You can turn it off in Settings › Sharing & access.</p>
    </div>
    {#if gate.error}
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{gate.error}</p>
    {/if}
    {#if turnOn === "here"}
      <div>
        <Button size="sm" disabled={gate.turningOn || busy} onclick={() => void outsideAppsDialog.turnOn(serverId)}>
          {#if gate.turningOn}
            <SpinnerIcon size={14} class="motion-safe:animate-spin" />
            Turning on…
          {:else}
            Turn on
          {/if}
        </Button>
      </div>
    {:else if turnOn === "policy" && lock}
      <ManagedSettingNote note={lock} />
    {:else if turnOn === "cloud"}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">Solus Cloud gives {hostName} its address while the machine runs. Check again in a moment.</p>
      {@render checkAgain()}
    {:else}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">On {hostName}, open Settings › Hosts › {hostName} › Access and turn on Reachable from the internet, or run <code class="font-mono">solus connect</code> there.</p>
      {@render checkAgain()}
    {/if}
  {:else if gate.kind === "offline"}
    <h3 class="text-base font-medium text-(--solus-text-primary)">
      {gate.where === "host" ? `Solus cannot reach ${hostName}` : `${hostName} does not answer at its public address`}
    </h3>
    <div class="flex flex-col gap-1 text-workspace-chrome text-(--solus-text-secondary) select-text">
      <p>{gate.reason}</p>
      {#if gate.fix}<p><span class="font-medium text-(--solus-text-primary)">Fix:</span> {gate.fix}</p>{/if}
    </div>
    {@render checkAgain()}
  {/if}
</section>
