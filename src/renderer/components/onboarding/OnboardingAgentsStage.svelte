<script lang="ts">
  /**
   * "Two agents, one step each." Every row is read off the bound host's
   * readiness through the same setup session Settings uses, so an agent that was
   * already installed and signed in arrives here as done without being touched.
   */
  import { onMount } from "svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { AGENT_PRESENTATION } from "./lib/onboarding-model";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import DevicePrompt from "../servers/DevicePrompt.svelte";
  import type { SetupAgent } from "../../../shared/types";

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

  /** A CLI either shows a code to enter on its sign-in page, or wants one pasted back. */
  const why = (label: string, requiresCodeInput: boolean | undefined) =>
    requiresCodeInput
      ? `${label} opened your browser. Finish signing in, then paste the returned code here.`
      : `Enter this code on the ${label} sign-in page in your browser.`;

  onMount(() => {
    setup.retain();
    return () => setup.release();
  });
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-[1.5rem] font-medium leading-[1.12] sm:text-[1.5rem]"
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
        {@const agent = row.id as SetupAgent}
        {@const verification = setup.verifications[agent]}
        {@const failure =
          setup.stepError?.provider === agent ? setup.stepError.message : null}
        <OnboardingRow
          name={row.label}
          detail={row.detail}
          delay={index * 0.07}
          tint={AGENT_PRESENTATION[agent].tint}
          abbr={AGENT_PRESENTATION[agent].abbr}
          state={row.state}
          statusText={row.state === "busy" ? row.detail : undefined}
          actionLabel={row.actionLabel}
          onaction={row.run}
          expanded={!!verification || !!failure}
        >
          {#snippet expansion()}
            {#if verification}
              <!-- The same prompt Settings shows: the one-time code some CLIs
                   want entered on the page, or the field for a code the page
                   hands back. -->
              <DevicePrompt
                url={verification.url}
                code={verification.code}
                label={row.label}
                requiresCodeInput={verification.requiresCodeInput}
                why={why(row.label, verification.requiresCodeInput)}
                onsubmit={(code) => setup.submitAgentSignInCode(agent, code)}
                oncancel={() => void setup.cancelAgentSignIn(agent)}
              />
            {:else if failure}
              <p
                class="cursor-text select-text text-pretty text-xs leading-relaxed text-(--solus-status-error)"
                role="alert"
              >
                {failure}
              </p>
            {/if}
          {/snippet}
        </OnboardingRow>
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
