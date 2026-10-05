<script lang="ts">
  import { Package as PackageIcon } from "@lucide/svelte";
  import type { DeviceBuildRef, DeviceSummary } from "@solus/contracts/device-types";
  import { deviceBuildTargets } from "@solus/client-core/device-builds";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { openDeviceBuilds } from "./lib/device-view-state.svelte";
  import { runDeviceBuild } from "./lib/run-build";

  /**
   * An app build the agent handed to Solus (plan 016, S02). One click runs it
   * on the best device and shows it: a stopped simulator boots and opens
   * beside the conversation, a connected phone gets the app opened on it.
   * Other devices and every build are behind ⋯.
   */
  interface Props {
    buildRef: DeviceBuildRef;
    /** The host that holds the build. */
    serverId: string | undefined;
    sessionId: string | undefined;
    skipMotion?: boolean;
  }

  let { buildRef, serverId, sessionId, skipMotion = false }: Props = $props();
  const session = getWorkspaceContext();

  const deviceState = $derived(serverId ? devicesStore.state(serverId) : undefined);
  const build = $derived(deviceState?.builds.find((candidate) => candidate.buildId === buildRef.buildId));
  const targets = $derived(build ? deviceBuildTargets(deviceState, build, { canBoot: !!sessionId }) : []);
  let running = $state<string | null>(null);

  $effect(() => {
    if (serverId && !devicesStore.state(serverId) && !devicesStore.unavailable.get(serverId)) void devicesStore.load(serverId);
  });

  async function run(device: DeviceSummary) {
    if (!serverId || !build || running) return;
    running = device.name;
    try {
      const shown = await runDeviceBuild(session, serverId, sessionId, build, device);
      if (shown.physical) toasts.success(`${build.name} is open on ${shown.name}`);
    } catch (cause) {
      toasts.error(`${build.name} did not run on ${device.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      running = null;
      requestInputFocus();
    }
  }

  function openBuilds() {
    if (serverId) openDeviceBuilds(session, serverId, sessionId);
  }
</script>

<TranscriptCard
  title={buildRef.name}
  type="build"
  target={buildRef.installedOn ? `installed on ${buildRef.installedOn}` : (buildRef.appId ?? undefined)}
  ariaLabel={`App build ${buildRef.name}`}
  glyphClass={buildRef.installedOn ? "is-done" : undefined}
  data-testid="device-build-card"
  {skipMotion}
>
  {#snippet glyph()}<PackageIcon />{/snippet}
  {#snippet actions()}
    {#if targets[0]}
      {@const best = targets[0]}
      <TranscriptCardAction disabled={running !== null} onclick={() => void run(best)}>
        {running ? `Running on ${running}…` : `Run on ${best.name}`}
      </TranscriptCardAction>
    {:else}
      <TranscriptCardAction kind="ghost" onclick={openBuilds}>Builds</TranscriptCardAction>
    {/if}
  {/snippet}
  {#snippet menu()}
    {#each targets.slice(1) as device (`${device.deviceHostId}:${device.deviceId}`)}
      <TranscriptCardAction kind="item" disabled={running !== null} onclick={() => void run(device)}>
        Run on {device.name}{device.physical ? "" : device.booted ? "" : " (starts it)"}
      </TranscriptCardAction>
    {/each}
    <TranscriptCardAction kind="item" onclick={openBuilds}>All builds</TranscriptCardAction>
  {/snippet}
</TranscriptCard>
