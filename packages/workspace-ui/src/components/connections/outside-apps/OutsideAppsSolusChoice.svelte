<script lang="ts">
  /** "Link to your Solus account" in the address gate: register the host, turn
   *  its Solus Cloud address on, or see why the address does not answer. Only a
   *  local owner registers and turns it on here; anyone else sees where. */
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { accountStore, uplinkStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { hostLock } from "../../settings/policy/managed-setting.svelte";
  import ManagedSettingNote from "../../settings/policy/ManagedSettingNote.svelte";
  import { registerWay, turnOnWay, type SolusAddressState } from "../lib/outside-apps-gate";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    solus: SolusAddressState;
  }

  let { serverId, hostName, solus }: Props = $props();

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

  // Only the kind: a new state object on each read would run the check again and again.
  const solusKind = $derived(solus.kind);
  // A person who signs in here comes back to a host that the owner's client now registers by itself.
  $effect(() => {
    if (solusKind !== "not-registered" || !uplinkStore.canLink) return;
    void outsideAppsDialog.check(serverId);
  });
</script>

{#snippet checkAgain()}
  <div>
    <Button variant="outline" size="sm" onclick={() => void outsideAppsDialog.check(serverId)}>Check again</Button>
  </div>
{/snippet}

<p class="text-chrome-dense text-(--solus-text-secondary)">Only apps you approve can use the address. You can turn it off in Settings › Sharing & access.</p>
{#if solus.kind === "not-registered"}
  {#if register === "register"}
    <div>
      <Button size="sm" disabled={busy} onclick={() => void outsideAppsDialog.register(serverId)}>
        {busy ? "Registering…" : `Register ${hostName}`}
      </Button>
    </div>
  {:else if register === "sign-in"}
    <p class="text-chrome-dense text-(--solus-text-secondary)">Sign in to Solus to register {hostName} to your account.</p>
    <div>
      {#if accountStore.state.kind === "signing-in"}
        <Button variant="outline" size="sm" onclick={() => accountStore.cancelSignIn()}>Cancel sign-in</Button>
      {:else}
        <Button size="sm" disabled={accountStore.state.kind === "unavailable"} onclick={() => void accountStore.signIn()}>Sign in</Button>
      {/if}
    </div>
  {:else}
    <p class="text-chrome-dense text-(--solus-text-secondary)">Open Solus on {hostName}, or from your Solus Cloud account, and register {hostName} in Settings › Sharing & access.</p>
    {@render checkAgain()}
  {/if}
{:else if solus.kind === "turn-on"}
  {#if solus.error}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{solus.error}</p>
  {/if}
  {#if turnOn === "here"}
    <div>
      <Button size="sm" disabled={solus.turningOn || busy} onclick={() => void outsideAppsDialog.turnOn(serverId)}>
        {#if solus.turningOn}
          <SpinnerIcon size={14} class="motion-safe:animate-spin" />
          Turning on…
        {:else}
          Turn on the public address
        {/if}
      </Button>
    </div>
  {:else if turnOn === "policy" && lock}
    <ManagedSettingNote note={lock} />
  {:else if turnOn === "cloud"}
    <p class="text-chrome-dense text-(--solus-text-secondary)">Solus Cloud gives {hostName} its address while the machine runs. Check again in a moment.</p>
    {@render checkAgain()}
  {:else}
    <p class="text-chrome-dense text-(--solus-text-secondary)">On {hostName}, open Settings › Sharing & access and turn on Reachable from the internet, or run <code class="font-mono">solus connect</code> there.</p>
    {@render checkAgain()}
  {/if}
{:else}
  <p role="alert" class="text-chrome-dense text-(--solus-status-error) select-text">{solus.reason}</p>
  {@render checkAgain()}
{/if}
