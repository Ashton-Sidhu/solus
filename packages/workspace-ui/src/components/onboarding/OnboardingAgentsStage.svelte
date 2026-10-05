<script lang="ts">
  /**
   * Cloud rows read the account vault. Personal-host rows read that host's
   * readiness through the same setup session Settings uses.
   */
  import { onMount } from "svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import OnboardingAgentRow from "./OnboardingAgentRow.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import type { SetupAgent } from "@solus/contracts/types";
  import { cloudAgentSeatsStore as cloudSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import { SETUP_PROVIDERS, type ProviderRow } from "../servers/lib/host-onboarding";
  import { seatProviderFor } from "../servers/host-setup.store.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";

  const setup = $derived(store.setup);
  const rows = $derived(
    store.flow === "cloud" ? SETUP_PROVIDERS.map(({ id, label }): ProviderRow => ({
      id, label,
      detail: cloudSeats.connected(seatProviderFor(id)) ? "Connected to your Solus Cloud account" : "Connect on your account’s Connections page",
      state: cloudSeats.connected(seatProviderFor(id)) ? "done" : "available",
      actionLabel: "Connect",
      run: () => cloudSeats.connect(),
    })) : codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (agent, opts) => void setup.addProvider(agent, opts),
    }),
  );
  const readyCount = $derived(rows.filter((row) => row.state === "done").length);
  /** Nothing has been heard from the host yet, so the rows are placeholders. */
  const probing = $derived(
    store.flow === "cloud" ? cloudSeats.seats === null && !cloudSeats.error : !setup.readiness && !setup.readinessError,
  );
  const checkError = $derived(store.flow === "cloud" ? cloudSeats.error : setup.readinessError);

  const title = $derived(
    probing
      ? "Checking your coding agents"
      : readyCount === rows.length
        ? "Your agents are ready"
        : readyCount > 0
          ? "One agent is ready"
          : "Two agents, one step each",
  );

  onMount(() => {
    if (store.flow === "cloud") return cloudSeats.watch();
    setup.retain();
    // The intro starts a probe early, but a remote client's active host can
    // settle after that request starts. Probe the host this stage actually
    // renders instead of turning a missing answer into missing CLIs.
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
  {#if store.flow === "cloud"}
    <p class="onboarding-title mt-3 max-w-[40ch] text-center text-sm leading-[1.6] text-muted-foreground">
      Your agent connections belong to your Solus Cloud account and work across your cloud hosts.
    </p>
  {/if}

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    {#if probing}
      {#each [0, 1] as index (index)}
        <div
          class="flex h-[4.5rem] items-center gap-4 rounded-2xl bg-[var(--solus-tx-card-bg)] px-4 shadow-[shadow:var(--solus-tx-card-shadow)]"
        >
          <span class="size-10 shrink-0 rounded-full bg-[var(--wash-2)]"></span>
          <span class="flex flex-col gap-2">
            <span class="h-2.5 w-[6.5rem] rounded-full bg-[var(--wash-2)]"></span>
            <span class="h-2 w-[9.875rem] rounded-full bg-[var(--wash-2)] opacity-60"></span>
          </span>
        </div>
      {/each}
    {:else if checkError}
      <OnboardingRow
        name={store.flow === "cloud" ? "Could not check your connections" : "Could not check this host"}
        detail={checkError}
        tint="var(--solus-status-error)"
        state="available"
        actionLabel="Retry"
        onaction={() => void (store.flow === "cloud" ? cloudSeats.refresh() : setup.refreshReadiness())}
      />
    {:else}
      {#each rows as row, index (row.id)}
        {#if store.flow === "cloud"}
          <OnboardingRow name={row.label} detail={row.detail} delay={index * 0.07} state={row.state} actionLabel={row.actionLabel} onaction={row.run}>
            {#snippet mark()}<ProviderMark mark={row.id as SetupAgent} size={24} transparent />{/snippet}
          </OnboardingRow>
        {:else}
        <OnboardingAgentRow
          agent={row.id as SetupAgent}
          {row}
          delay={index * 0.07}
        />
        {/if}
      {/each}
    {/if}
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled={readyCount > 0}
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
  />
</div>
