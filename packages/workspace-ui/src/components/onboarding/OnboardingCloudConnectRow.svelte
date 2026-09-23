<script lang="ts">
  /**
   * The optional last row of desktop onboarding: connect this app to a Solus
   * Cloud account and link this Mac (docs/plans/cloud-onboarding.md §4). Only
   * the desktop shell can hold an account (`accountStore.isAvailable`), so the
   * row is absent everywhere else. It never gates Start.
   */
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { Cloud as CloudIcon } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { accountStore, uplinkStore } from "../../contexts";
  import { cloudConnectRow } from "./lib/cloud-connect-row";
  import OnboardingRow from "./OnboardingRow.svelte";

  let { delay = 0 }: { delay?: number } = $props();

  const row = $derived(
    cloudConnectRow({
      account: accountStore.state,
      uplink: uplinkStore.statusFor(LOCAL_SERVER_ID),
      isLinking: uplinkStore.busyServerId === LOCAL_SERVER_ID,
    }),
  );

  onMount(() => {
    accountStore.start();
    void uplinkStore.refresh(LOCAL_SERVER_ID);
  });

  /** One action for both halves: the browser approves the sign-in, then this Mac is linked. */
  async function connect() {
    if (!accountStore.isSignedIn) {
      const ended = await accountStore.signIn();
      if (ended !== "approved") return;
    }
    await uplinkStore.link(LOCAL_SERVER_ID);
  }
</script>

{#if accountStore.isAvailable}
  <OnboardingRow
    name="Connect to Solus Cloud"
    detail={row.detail}
    {delay}
    tint="var(--chart-2)"
    state={row.state}
    statusText="Waiting…"
    actionLabel={row.actionLabel}
    onaction={() => void connect()}
  >
    {#snippet mark()}<CloudIcon size={18} />{/snippet}
  </OnboardingRow>
{/if}
