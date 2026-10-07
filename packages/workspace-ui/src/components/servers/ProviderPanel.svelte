<script lang="ts">
  import { hostUpdatesStore } from "../../contexts/updates/host-updates.store.svelte";
  import { providerUpdateRows } from "../connections/lib/host-update-rows";
  import SignInSteps from "../seats/SignInSteps.svelte";
  import ProviderChoiceCard from "./ProviderChoiceCard.svelte";
  import type { HostSetupSession } from "./host-setup.store.svelte";
  import {
    codingProviderRows,
    SETUP_PROVIDERS,
  } from "./lib/host-onboarding";

  interface Props {
    setup: HostSetupSession;
    /** Draw the rows flush on the surface, as host onboarding does. */
    flush?: boolean;
  }

  let { setup, flush = false }: Props = $props();

  const rows = $derived(
    providerUpdateRows(codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (provider, opts) => void setup.addProvider(provider, opts),
    }), hostUpdatesStore.providerUpdatesFor(setup.serverId), (agent) => void setup.updateProvider(agent)),
  );
</script>

<div>
  <ProviderChoiceCard {rows} {flush} label="Coding providers" />
  {#each SETUP_PROVIDERS as { id: provider, label } (provider)}
    {@const verification = setup.verificationFor(provider)}
    {#if verification}
      <div class="mt-3">
        <SignInSteps
          {label}
          {verification}
            onsubmit={(code) => setup.submitAgentSignInCode(provider, code)}
          oncancel={() => void setup.cancelAgentSignIn(provider)}
        />
      </div>
    {/if}
  {/each}
  {#if setup.stepError?.step === "providers"}
    <p class="mt-3 cursor-text select-text text-pretty text-[0.875em] text-(--solus-status-error)">
      {setup.stepError.message}
    </p>
  {/if}
</div>
