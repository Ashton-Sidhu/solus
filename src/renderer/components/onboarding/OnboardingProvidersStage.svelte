<script lang="ts">
  /**
   * "Connect where your work lives." Both rows drive the connections the rest of
   * the app already uses — GitHub's device flow and the Cloudflare token form —
   * so anything connected here is connected everywhere, and Settings shows it
   * without a second round trip.
   */
  import { serverConnections } from "@client-core/server-connections";
  import { CloudIcon } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { cloudflareStore, connectionsStore } from "../../contexts";
  import CloudflareConnectForm from "../cloudflare/CloudflareConnectForm.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingGithubRow from "./OnboardingGithubRow.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  const serverId = serverConnections.defaultServerId();

  /** Open only while the user is actually pasting a token. */
  let cloudflareFormOpen = $state(false);

  const githubConnected = $derived(!!connectionsStore.providerStatus?.connected);
  const cloudflareConnected = $derived(!!cloudflareStore.status?.connected);
  const connectedCount = $derived(
    Number(githubConnected) + Number(cloudflareConnected),
  );

  const cloudflareDetail = $derived(
    cloudflareConnected
      ? `${cloudflareStore.status?.accountName ?? "Connected"} · Workers, D1, KV and R2`
      : "Deploys and bindings the agent can reach",
  );

  onMount(() => {
    if (!serverId) return;
    void cloudflareStore.ensureStatus(serverId);
  });
</script>

<div
  class="text-xs flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12] sm:text-2xl"
  >
    Connect where your work lives
  </h1>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingGithubRow />

    <OnboardingRow
      name="Cloudflare"
      detail={cloudflareDetail}
      delay={0.07}
      tint="var(--chart-2)"
      state={cloudflareConnected ? "done" : "available"}
      actionLabel={cloudflareConnected
        ? undefined
        : cloudflareFormOpen
          ? undefined
          : "Connect"}
      onaction={() => (cloudflareFormOpen = true)}
      expanded={cloudflareFormOpen && !cloudflareConnected}
    >
      {#snippet mark()}
        <CloudIcon size={18} />
      {/snippet}
      {#snippet expansion()}
        <!-- Cloudflare has no browser handshake to hand off to: it wants a
             scoped API token, so the row opens the same form Settings uses
             rather than pretending a one-click connect exists. -->
        {#if serverId}
        <CloudflareConnectForm
          {serverId}
          autofocus
          onconnected={() => (cloudflareFormOpen = false)}
        />
        {/if}
        <button
          type="button"
          class="mt-2 h-7 rounded-md  text-muted-foreground transition-colors duration-150 hover:text-foreground"
          onclick={() => {
            cloudflareStore.clearFailure();
            cloudflareFormOpen = false;
          }}
        >
          Not now
        </button>
      {/snippet}
    </OnboardingRow>
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled={connectedCount > 0}
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
  />
</div>
