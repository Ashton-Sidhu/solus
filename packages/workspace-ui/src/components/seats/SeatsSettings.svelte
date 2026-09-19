<script lang="ts">
  /**
   * Settings → Providers → Your seats (docs/plans/provider-seats.md §3.6): the
   * login this client's turns run on. For the host's owner that is the host login
   * the setup wizard signs in; for an organization member it is their own seat.
   * A guest has none. On the organization's workspace service the same rows are
   * the logins kept in Solus cloud, which every runner uses for the person's turns
   * (docs/plans/cloud-service-model.md); a member on a runner is pointed there.
   */
  import { LogOut as SignOutIcon } from "@lucide/svelte";
  import { SEAT_PROVIDERS } from "@solus/contracts/seats";
  import { seatsStore, serversStore, sharesStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import ProviderConnectedCheck from "../settings/ProviderConnectedCheck.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import CloudConnectionsPointer from "./CloudConnectionsPointer.svelte";
  import SeatConnectPanel from "./SeatConnectPanel.svelte";
  import { cloudConnectionsPointerUrl } from "./lib/cloud-connections";
  import { seatAction, seatDescription, seatLabel, seatSectionCopy } from "./lib/seat-copy";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => {
    void seatsStore.ensure(serverId);
  });

  const hasSeats = $derived(seatsStore.hasSeats.get(serverId) === true);
  const isCloudHost = $derived(serversStore.isCloudHost(serverId));
  const sectionCopy = $derived(seatSectionCopy(isCloudHost));

  // Who this client is to the host, from the store's cache: a member admitted
  // through an organization keeps their logins in Solus cloud, not on the runner.
  $effect(() => {
    void sharesStore.identityFor(serverId).catch(() => {});
  });
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      isCloudHost,
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );

  async function disconnect(provider: (typeof SEAT_PROVIDERS)[number]) {
    await seatsStore.disconnect(serverId, provider);
    requestInputFocus();
  }
</script>

{#snippet panel(provider: (typeof SEAT_PROVIDERS)[number])}
  <SeatConnectPanel {serverId} {provider} />
{/snippet}

<SettingsSection label={sectionCopy.label} description={sectionCopy.description} visible={hasSeats}>
  {#if cloudConnectionsUrl}
    <CloudConnectionsPointer
      url={cloudConnectionsUrl}
      label="Your logins are connected in Solus cloud"
      description="Every runner of your organization uses them for your own turns only."
      testId="seat-row-cloud"
    />
  {/if}
  {#each SEAT_PROVIDERS as provider (provider)}
    {@const status = seatsStore.statusFor(serverId, provider)}
    {@const action = seatAction(status)}
    <SettingsRow
      label={seatLabel(provider)}
      description={seatDescription(status, seatsStore.errorFor(serverId, provider))}
      body={action === "disconnect" ? undefined : panel}
      testId="seat-row-{provider}"
    >
      {#snippet labelExtra()}
        <span class="ml-1.5 inline-flex size-[0.8125rem] items-center justify-center align-[-0.15em] text-(--solus-accent) {provider === 'codex' ? 'rounded-full bg-white' : ''}">
          {#if provider === "claude-code"}
            <ClaudeIcon size={13} />
          {:else}
            <OpenAIBlossom size={11} />
          {/if}
        </span>
        <ProviderConnectedCheck connected={status?.state === "connected"} provider={seatLabel(provider)} />
      {/snippet}
      {#snippet control()}
        {#if action === "disconnect"}
          <Button variant="outline" size="sm" disabled={seatsStore.isBusy(serverId, provider)} onclick={() => void disconnect(provider)}>
            <SignOutIcon size={13} />
            Disconnect
          </Button>
        {/if}
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>
