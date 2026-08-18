<script lang="ts">
  /**
   * The touch flow's one setup stage, in place of the pointer flow's `agents`
   * and `providers`.
   *
   * A phone has no agents and no repositories of its own: everything those two
   * stages ask about belongs to the machine this client is driving, and that
   * machine has usually been set up already from its own desktop. So this stage
   * reports where the machine stands and only asks about what is actually
   * missing — a ready host is a sentence, not two screens of check marks.
   *
   * Cloudflare is deliberately absent. It is the one connection with no browser
   * handshake to hand off to: it wants a scoped API token pasted in, which is a
   * bad thing to ask of a thumb and is never blocking. Settings still has it.
   */
  import { serverConnections } from "@client-core/server-connections";
  import { DesktopTowerIcon } from "phosphor-svelte";
  import { onMount } from "svelte";
  import {
    connectionsStore,
    getWorkspaceContext,
    serversStore,
  } from "../../contexts";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingAgentRow from "./OnboardingAgentRow.svelte";
  import OnboardingGithubRow from "./OnboardingGithubRow.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import type { SetupAgent } from "../../../shared/types";

  const session = getWorkspaceContext();
  const serverId = serverConnections.defaultServerId();

  const setup = $derived(store.setup);
  const hostName = $derived(serversStore.activeServer?.label ?? "your machine");

  /**
   * Nothing has been heard from the host yet, so there is nothing to report.
   * GitHub counts: this stage hides the row once it is connected, so without
   * waiting for the first answer a set-up host flashes a Connect row and then
   * takes it away again.
   */
  const probing = $derived(
    (setup.readinessLoading && !setup.readiness) ||
      connectionsStore.providerStatus === null,
  );

  const agentRows = $derived(
    codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (agent, opts) => void setup.addProvider(agent, opts),
    }),
  );
  /**
   * Only what is unfinished. The pointer flow keeps every agent listed so the
   * second one stays one click away, but that argument is about a machine the
   * user is sitting at. From a phone, a settled agent is noise.
   */
  const unfinishedAgents = $derived(
    agentRows.filter((row) => row.state !== "done"),
  );
  const hasSignedInAgent = $derived(
    agentRows.some((row) => row.state === "done"),
  );
  const githubConnected = $derived(!!connectionsStore.providerStatus?.connected);
  const ready = $derived(hasSignedInAgent && githubConnected);
  /** What the one confirming row says a ready host already has. */
  const readyDetail = $derived(
    [...agentRows.filter((row) => row.state === "done").map((row) => row.label), "GitHub"].join(" · "),
  );

  const title = $derived(
    probing
      ? `Checking ${hostName}`
      : ready
        ? `${hostName} is ready`
        : `Finish setting up ${hostName}`,
  );

  onMount(() => {
    setup.retain();
    // The GitHub row fetches this too, but it is only mounted when GitHub is
    // *not* connected — which is the answer this is waiting for.
    if (serverId) void connectionsStore.refreshProviderStatus(serverId, session.ctx);
    return () => setup.release();
  });
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12] sm:text-2xl"
  >
    {title}
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[34ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    <!-- The one thing a phone user has to understand: the work is not happening
         here, so leaving does not stop it. -->
    Agents run on {hostName}, not on this device. Close the tab and they keep
    going.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    {#if probing}
      <div
        class="flex h-[4.5rem] items-center gap-4 rounded-2xl bg-[var(--wash-1)] px-4"
      >
        <span class="size-10 shrink-0 rounded-full bg-[var(--wash-2)]"></span>
        <span class="flex flex-col gap-2">
          <span class="h-2.5 w-[6.5rem] rounded-full bg-[var(--wash-2)]"></span>
          <span class="h-2 w-[9.875rem] rounded-full bg-[var(--wash-2)] opacity-60"></span>
        </span>
      </div>
    {:else if ready}
      <!-- One row rather than none: "it is ready" with an empty column under it
           reads as a stage that failed to load. -->
      <OnboardingRow
        name="Set up and signed in"
        detail={readyDetail}
        tint="var(--success)"
        state="done"
      >
        {#snippet mark()}
          <DesktopTowerIcon size={18} />
        {/snippet}
      </OnboardingRow>
    {:else}
      {#each unfinishedAgents as row, index (row.id)}
        <OnboardingAgentRow
          agent={row.id as SetupAgent}
          {row}
          delay={index * 0.07}
        />
      {/each}
      {#if !githubConnected}
        <OnboardingGithubRow delay={unfinishedAgents.length * 0.07} />
      {/if}
    {/if}
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
  />
</div>
