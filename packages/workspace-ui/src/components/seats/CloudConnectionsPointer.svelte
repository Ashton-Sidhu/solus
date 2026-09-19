<script lang="ts">
  /**
   * The one row a runner shows an organization member instead of a connection
   * section: the connection lives in Solus cloud, and this opens that page.
   * `cloudConnectionsPointerUrl` in `lib/cloud-connections.ts` decides when.
   */
  import { ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";

  interface Props {
    url: string;
    label: string;
    description: string;
    testId?: string;
  }

  let { url, label, description, testId }: Props = $props();
</script>

<SettingsRow {label} {description} {testId}>
  {#snippet control()}
    <Button variant="outline" size="sm" onclick={() => void localApi.openExternal(url)}>
      <ExternalLinkIcon size={13} />
      Open in Solus cloud
    </Button>
  {/snippet}
</SettingsRow>
