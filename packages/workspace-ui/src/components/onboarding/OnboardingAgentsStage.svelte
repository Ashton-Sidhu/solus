<script lang="ts">
  /**
   * "Two agents, one step each." Every row is read off the bound host's
   * readiness through the same setup session Settings uses, so an agent that was
   * already installed and signed in arrives here as done without being touched.
   */
  import { onMount } from "svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import OnboardingAgentRow from "./OnboardingAgentRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import type { SetupAgent } from "@solus/contracts/types";

  const setup = $derived(store.setup);
  const rows = $derived(
    codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (agent, opts) => void setup.addProvider(agent, opts),
    }),
  );
  const readyCount = $derived(rows.filter((row) => row.state === "done").length);
  /** Nothing has been heard from the host yet, so the rows are placeholders. */
  const probing = $derived(setup.readinessLoading && !setup.readiness);

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
    setup.retain();
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

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    {#if probing}
      {#each [0, 1] as index (index)}
        <div
          class="flex h-[4.5rem] items-center gap-4 rounded-2xl bg-[var(--wash-1)] px-4"
        >
          <span class="size-10 shrink-0 rounded-full bg-[var(--wash-2)]"></span>
          <span class="flex flex-col gap-2">
            <span class="h-2.5 w-[6.5rem] rounded-full bg-[var(--wash-2)]"></span>
            <span class="h-2 w-[9.875rem] rounded-full bg-[var(--wash-2)] opacity-60"></span>
          </span>
        </div>
      {/each}
    {:else}
      {#each rows as row, index (row.id)}
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
    continueEnabled={readyCount > 0}
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
  />
</div>
