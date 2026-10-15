<script lang="ts">
  /**
   * The touch flow's one setup stage, in place of the pointer flow's `agents`.
   *
   * A phone has no agents of its own: everything that stage asks about belongs
   * to the machine this client is driving, and that machine has usually been
   * set up already from its own desktop. So this stage reports where the
   * machine stands and only asks about what is actually missing — a ready host
   * is a sentence, not a screen of check marks. Connections such as GitHub are
   * in Settings, not here.
   */
  import { HardDrive as DesktopTowerIcon } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { serversStore } from "../../contexts";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingAgentRow from "./OnboardingAgentRow.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import type { SetupAgent } from "@solus/contracts/types";

  const serverId = store.serverId;

  const setup = $derived(store.setup);
  const hostName = $derived(serversStore.hostFor(serverId)?.label ?? "your machine");

  /** Nothing has been heard from the host yet, so there is nothing to report. */
  const probing = $derived(!setup.readinessError && !setup.readiness);

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
  const ready = $derived(
    agentRows.some((row) => row.state === "done"),
  );
  /** What the one confirming row says a ready host already has. */
  const readyDetail = $derived(
    agentRows.filter((row) => row.state === "done").map((row) => row.label).join(" · "),
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
    // `start()` probes behind the intro. On a remote client the selected host
    // can change while the socket settles, so refresh the host this stage is
    // now reporting before it labels either CLI as absent.
    if (!setup.readiness && !setup.readinessLoading) {
      void setup.refreshReadiness();
    }
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
        class="flex h-[4.5rem] items-center gap-4 rounded-2xl bg-[var(--solus-tx-card-bg)] px-4 shadow-[shadow:var(--solus-tx-card-shadow)]"
      >
        <span class="size-10 shrink-0 rounded-full bg-[var(--wash-2)]"></span>
        <span class="flex flex-col gap-2">
          <span class="h-2.5 w-[6.5rem] rounded-full bg-[var(--wash-2)]"></span>
          <span class="h-2 w-[9.875rem] rounded-full bg-[var(--wash-2)] opacity-60"></span>
        </span>
      </div>
    {:else if setup.readinessError}
      <OnboardingRow
        name="Could not check {hostName}"
        detail={setup.readinessError}
        tint="var(--solus-status-error)"
        state="available"
        actionLabel="Retry"
        onaction={() => void setup.refreshReadiness()}
      />
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
