<script lang="ts">
  /**
   * GitHub, through the device flow the rest of the app already uses, so a
   * connection made here is a connection Settings shows without a second round
   * trip. Shared by the pointer flow's providers stage and the touch flow's
   * host stage.
   */
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    ArrowSquareOutIcon,
    CheckIcon,
    CopyIcon,
    GithubLogoIcon,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { connectionsStore, getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import OnboardingRow from "./OnboardingRow.svelte";

  interface Props {
    delay?: number;
  }

  let { delay = 0 }: Props = $props();

  const session = getWorkspaceContext();
  const serverId = serverConnections.defaultServerId();

  let copiedDeviceCode = $state(false);

  // Callers gate their own Continue off `connectionsStore.providerStatus`
  // directly rather than being handed it back from here — it is the same store.
  const status = $derived(connectionsStore.providerStatus);

  const detail = $derived(
    status?.connected
      ? status.login
        ? `Connected as @${status.login}`
        : "Connected"
      : connectionsStore.providerConnecting
        ? "Waiting on your browser…"
        : "Repositories, branches and pull requests",
  );

  onMount(() => {
    if (!serverId) return;
    void connectionsStore.refreshProviderStatus(serverId, session.ctx);
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

<OnboardingRow
  name="GitHub"
  {detail}
  {delay}
  tint="var(--chart-5)"
  state={status?.connected
    ? "done"
    : connectionsStore.providerConnecting
      ? "busy"
      : "available"}
  statusText="Connecting…"
  actionLabel={status?.connected ? undefined : "Connect"}
  onaction={() =>
    serverId && void connectionsStore.connectProvider(serverId, session.ctx)}
  expanded={!!connectionsStore.providerPrompt}
>
  {#snippet mark()}
    <GithubLogoIcon size={18} weight="fill" />
  {/snippet}
  {#snippet expansion()}
    {#if connectionsStore.providerPrompt}
      {@const prompt = connectionsStore.providerPrompt}
      <div class="flex flex-col gap-2.5 text-xs">
        <p class="leading-relaxed text-muted-foreground">
          Enter this code at github.com/login/device.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <code class="text-sm font-medium tabular-nums">{prompt.userCode}</code>
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
            onclick={() => void localApi.openExternal(prompt.verificationUri)}
          >
            <ArrowSquareOutIcon size={12} />
            Open github.com/login/device
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="text-muted-foreground"
            onclick={() =>
              serverId &&
              void connectionsStore.cancelProviderConnect(serverId, session.ctx)}
          >
            Cancel
          </Button>
        </div>
      </div>
    {/if}
  {/snippet}
</OnboardingRow>
