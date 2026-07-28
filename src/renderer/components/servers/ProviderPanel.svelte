<script lang="ts">
  import DevicePrompt from "./DevicePrompt.svelte";
  import ProviderChoiceCard from "./ProviderChoiceCard.svelte";
  import type { HostSetupSession } from "./host-setup.store.svelte";
  import {
    codingProviderRows,
    SETUP_PROVIDERS,
  } from "./lib/host-onboarding";

  interface Props {
    setup: HostSetupSession;
  }

  let { setup }: Props = $props();

  const rows = $derived(
    codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (provider) => void setup.runStep("providers", provider),
    }),
  );

  /** A host CLI can't reach this browser, so signing one in ends with a code coming back by hand. */
  const why = (label: string, requiresCodeInput: boolean | undefined) =>
    requiresCodeInput
      ? `Finish signing in with ${label}, then paste the returned code here.`
      : `Confirm this ${label} code in your browser, then come back.`;
</script>

<div>
  <ProviderChoiceCard {rows} label="Coding providers" />
  {#each SETUP_PROVIDERS as { id: provider, label } (provider)}
    {@const verification = setup.verifications[provider]}
    {#if verification}
      <DevicePrompt
        url={verification.url}
        code={verification.code}
        {label}
        requiresCodeInput={verification.requiresCodeInput}
        why={why(label, verification.requiresCodeInput)}
        onsubmit={(code) => setup.submitAgentSignInCode(provider, code)}
        oncancel={() => void setup.cancelAgentSignIn(provider)}
      />
    {/if}
  {/each}
  {#if setup.stepError?.step === "providers"}
    <p class="mt-3 cursor-text select-text text-pretty text-[0.75rem] text-(--solus-status-error)">
      {setup.stepError.message}
    </p>
  {/if}
</div>
