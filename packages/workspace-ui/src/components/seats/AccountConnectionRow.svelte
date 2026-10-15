<script lang="ts">
  /**
   * The row a signed-in person sees for one connection instead of the host's
   * own controls (docs/plans/cloud-vault.md §2.5): the status their Solus
   * account reports, and an action that opens the account's Connections page.
   * `cloudConnectionsPointerUrl` in `lib/cloud-connections.ts` decides when.
   */
  import { CircleCheck as CircleCheckIcon, ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";
  import { accountConnectionText, type AccountConnectionStatus } from "./lib/cloud-connections";

  interface Props {
    url: string;
    label: string;
    /** Null when this client has no account to read. */
    status: AccountConnectionStatus | null;
    testId?: string;
  }

  let { url, label, status, testId }: Props = $props();
</script>

<SettingsRow {label} description={accountConnectionText(status)} {testId}>
  {#snippet labelExtra()}
    {#if status?.kind === "connected"}
      <CircleCheckIcon
        size={13}
        role="img"
        aria-label="Connected in your Solus account"
        class="ml-1.5 inline-block shrink-0 align-[-0.15em] text-(--solus-status-complete)"
      />
    {/if}
  {/snippet}
  {#snippet control()}
    <Button variant="outline" size="sm" class="text-workspace-chrome" onclick={() => void localApi.openExternal(url)}>
      <ExternalLinkIcon size={16} />
      Connect on your account
    </Button>
  {/snippet}
</SettingsRow>
