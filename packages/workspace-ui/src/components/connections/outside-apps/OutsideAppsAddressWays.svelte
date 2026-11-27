<script lang="ts">
  /** The three ways to give a host an address apps reach (plans/035 §0.8):
   *  Tailscale (Serve for the tailnet, Funnel for the internet), Solus Cloud,
   *  and the person's own address. The no-address banner, an open row whose
   *  app has no address, and "Set up" under "Where apps reach this host" all
   *  show these. Tailscale and Solus Cloud change only from a local owner's
   *  client; anyone else reads where to do it. */
  import { untrack } from "svelte";
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { accountStore, connectionsStore, uplinkStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { hostLock } from "../../settings/policy/managed-setting.svelte";
  import ManagedSettingNote from "../../settings/policy/ManagedSettingNote.svelte";
  import { tailscaleCard, tailscaleWay, type AppAddressReach } from "../lib/app-addresses";
  import { registerWay, solusAddressState, solusCard, turnOnWay } from "../lib/outside-apps-gate";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppsOwnAddress from "./OutsideAppsOwnAddress.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    reach: AppAddressReach;
  }

  let { serverId, hostName, reach }: Props = $props();

  let isAddingAddress = $state(false);

  const host = $derived(hosts.get(serverId));
  const mayReachLocally = $derived(host.me.may("host.local.reach"));
  const tailscaleStatus = $derived(connectionsStore.appTailscaleFor(serverId) ?? null);
  const tailscale = $derived(tailscaleCard(tailscaleWay(tailscaleStatus, mayReachLocally), tailscaleStatus, reach, hostName));
  const tailscaleError = $derived(connectionsStore.appTailscaleErrorFor(serverId) ?? tailscaleStatus?.error ?? null);
  const isTailscaleBusy = $derived(connectionsStore.appTailscaleBusyServerId === serverId);
  const tailscaleFeature = $derived(reach === "internet" ? "Funnel" : "Serve");

  const uplink = $derived(uplinkStore.statusFor(serverId));
  const isTurningOn = $derived(outsideApps.turningOnServerId === serverId);
  const solusState = $derived(uplink ? solusAddressState(uplink, isTurningOn) : null);
  const cloudLock = $derived(hostLock(serverId, "cloudTunnel"));
  const solus = $derived(solusCard(
    solusState,
    registerWay({ control: uplinkStore.controlFor(serverId), accountAvailable: uplinkStore.accountAvailable, canLink: uplinkStore.canLink }),
    turnOnWay({
      hostKind: host.serverInfo.state === "ready" ? host.serverInfo.value.hostKind : undefined,
      control: uplinkStore.controlFor(serverId),
      mayReachLocally,
      locked: !!cloudLock,
    }),
    hostName,
  ));
  const isSolusBusy = $derived(uplinkStore.busyServerId === serverId || isTurningOn);

  const mayChangeSettings = $derived(host.me.may("host.admin"));
  const hasOwnAddress = $derived(connectionsStore.appEndpointFor(serverId)?.addresses.some((address) => address.source === "custom") ?? false);

  // The Solus Cloud card reads the link; the page has read the addresses and Tailscale already.
  $effect(() => {
    const targetServerId = serverId;
    untrack(() => { if (!uplinkStore.statusFor(targetServerId)) void outsideApps.readUplink(targetServerId); });
  });

  // A person who signs in here comes back to a host that the owner's client now registers by itself.
  const solusKind = $derived(solusState?.kind);
  $effect(() => {
    if (solusKind !== "not-registered" || !uplinkStore.canLink) return;
    untrack(() => void outsideApps.check(serverId));
  });

  function runSolus() {
    if (solus.action === "sign-in") void accountStore.signIn();
    else if (solus.action === "link") void outsideApps.link(serverId);
    else if (solus.action === "turn-on") void outsideApps.turnOn(serverId);
    else void outsideApps.check(serverId);
  }
</script>

{#snippet card(title: string, summary: string, action: import("svelte").Snippet)}
  <div class="flex min-w-0 flex-1 basis-48 flex-col gap-2.5 rounded-[0.625rem] bg-(--solus-container-bg) p-3.5 ring-1 ring-border">
    <div class="flex flex-col gap-0.5">
      <span class="text-[0.875rem] leading-4.5 font-semibold text-(--solus-text-primary)">{title}</span>
      <span class="text-chrome-dense text-pretty text-(--solus-text-tertiary) select-text">{summary}</span>
    </div>
    <div class="mt-auto self-start">{@render action()}</div>
  </div>
{/snippet}

{#snippet tailscaleAction()}
  {#if isTailscaleBusy || tailscale.action === "turn-on"}
    <Button size="sm" class="font-semibold" disabled={connectionsStore.appTailscaleBusyServerId !== null} onclick={() => void outsideApps.turnOnTailscale(serverId, reach)}>
      {#if isTailscaleBusy}<SpinnerIcon class="motion-safe:animate-spin" />Turning on {tailscaleFeature}…{:else}Turn on {tailscaleFeature}{/if}
    </Button>
  {:else if tailscale.action === "check"}
    <Button variant="outline" size="sm" onclick={() => void outsideApps.check(serverId)}>Check again</Button>
  {/if}
{/snippet}

{#snippet solusAction()}
  {#if solus.action === "policy" && cloudLock}
    <ManagedSettingNote note={cloudLock} />
  {:else if solus.action === "sign-in" && accountStore.state.kind === "signing-in"}
    <Button variant="outline" size="sm" onclick={() => accountStore.cancelSignIn()}>Cancel sign-in</Button>
  {:else if solus.action && solus.action !== "policy"}
    <Button
      variant="outline"
      size="sm"
      disabled={isSolusBusy || (solus.action === "sign-in" && accountStore.state.kind === "unavailable")}
      onclick={runSolus}
    >
      {#if isTurningOn}<SpinnerIcon class="motion-safe:animate-spin" />Turning on…{:else if solus.action === "sign-in"}Sign in and link{:else if solus.action === "link"}Link{:else if solus.action === "turn-on"}Turn on{:else}Check again{/if}
    </Button>
  {/if}
{/snippet}

{#snippet ownAction()}
  {#if mayChangeSettings}
    <Button variant="outline" size="sm" aria-expanded={isAddingAddress} onclick={() => (isAddingAddress = !isAddingAddress)}>
      {hasOwnAddress ? "Change address" : "Add address"}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-2.5">
  <div class="flex flex-wrap gap-2.5">
    {@render card(reach === "internet" ? "Tailscale Funnel" : "Tailscale", tailscale.summary, tailscaleAction)}
    {@render card("Solus Cloud", solus.summary ?? "A private tunnel with your account.", solusAction)}
    {@render card("Your own address", mayChangeSettings ? "A proxy or tunnel you run, over https." : `Ask the owner of ${hostName} to add one.`, ownAction)}
  </div>
  {#if tailscaleError}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error) select-text">{tailscaleError}</p>
  {/if}
  {#if isAddingAddress}
    <div class="rounded-[0.625rem] bg-(--solus-container-bg) p-3.5 ring-1 ring-border">
      <OutsideAppsOwnAddress {serverId} />
    </div>
  {/if}
</div>
