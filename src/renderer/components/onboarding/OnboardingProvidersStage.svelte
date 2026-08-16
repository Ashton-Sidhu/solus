<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import { serverConnections } from "@client-core/server-connections";
  /**
   * "Connect where your work lives." Both rows drive the connections the rest of
   * the app already uses — GitHub's device flow and the Cloudflare token form —
   * so anything connected here is connected everywhere, and Settings shows it
   * without a second round trip.
   */
  import {
    ArrowSquareOutIcon,
    CheckIcon,
    CloudIcon,
    CopyIcon,
    GithubLogoIcon,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import {
    cloudflareStore,
    connectionsStore,
    getWorkspaceContext,
  } from "../../contexts";
  import CloudflareConnectForm from "../cloudflare/CloudflareConnectForm.svelte";
  import { Button } from "../ui/button";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  const session = getWorkspaceContext();
  const serverId = serverConnections.defaultServerId();

  /** Open only while the user is actually pasting a token. */
  let cloudflareFormOpen = $state(false);
  let copiedDeviceCode = $state(false);

  const githubStatus = $derived(connectionsStore.providerStatus);
  const githubConnected = $derived(!!githubStatus?.connected);
  const cloudflareConnected = $derived(!!cloudflareStore.status?.connected);
  const connectedCount = $derived(
    Number(githubConnected) + Number(cloudflareConnected),
  );

  const githubDetail = $derived(
    githubConnected
      ? githubStatus?.login
        ? `Connected as @${githubStatus.login}`
        : "Connected"
      : connectionsStore.providerConnecting
        ? "Waiting on your browser…"
        : "Repositories, branches and pull requests",
  );

  const cloudflareDetail = $derived(
    cloudflareConnected
      ? `${cloudflareStore.status?.accountName ?? "Connected"} · Workers, D1, KV and R2`
      : "Deploys and bindings the agent can reach",
  );

  onMount(() => {
    if (!serverId) return;
    void connectionsStore.refreshProviderStatus(serverId, session.ctx);
    void cloudflareStore.ensureStatus(serverId);
    return connectionsStore.listenForProviderDeviceCodes();
  });

  function copyDeviceCode() {
    const prompt = connectionsStore.providerPrompt;
    if (!prompt) return;
    void navigator.clipboard?.writeText(prompt.userCode);
    copiedDeviceCode = true;
    setTimeout(() => (copiedDeviceCode = false), 1500);
  }
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-[1.5rem] font-medium leading-[1.12] sm:text-[1.5rem]"
  >
    Connect where your work lives
  </h1>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingRow
      name="GitHub"
      detail={githubDetail}
      tint="var(--chart-5)"
      state={githubConnected
        ? "done"
        : connectionsStore.providerConnecting
          ? "busy"
          : "available"}
      statusText="Connecting…"
      actionLabel={githubConnected ? undefined : "Connect"}
      onaction={() => serverId && void connectionsStore.connectProvider(serverId, session.ctx)}
      expanded={!!connectionsStore.providerPrompt}
    >
      {#snippet mark()}
        <GithubLogoIcon size={18} weight="fill" />
      {/snippet}
      {#snippet expansion()}
        {#if connectionsStore.providerPrompt}
          {@const prompt = connectionsStore.providerPrompt}
          <div class="flex flex-col gap-2.5">
            <p class="text-xs leading-relaxed text-muted-foreground">
              Enter this code at github.com/login/device.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <code
                class="font-mono text-sm font-medium tabular-nums"
                >{prompt.userCode}</code
              >
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground"
                aria-label="Copy code"
                onclick={copyDeviceCode}
              >
                {#if copiedDeviceCode}
                  <CheckIcon size={13} />
                {:else}
                  <CopyIcon size={13} />
                {/if}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onclick={() =>
                  void localApi.openExternal(prompt.verificationUri)}
              >
                <ArrowSquareOutIcon size={12} />
                Open github.com/login/device
              </Button>
              <Button
                size="sm"
                variant="ghost"
                class="text-muted-foreground"
                onclick={() =>
                  serverId && void connectionsStore.cancelProviderConnect(serverId, session.ctx)}
              >
                Cancel
              </Button>
            </div>
          </div>
        {/if}
      {/snippet}
    </OnboardingRow>

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
          class="mt-2 h-7 rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
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
