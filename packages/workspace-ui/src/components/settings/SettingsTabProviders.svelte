<script lang="ts">
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import CloudflareProviderSettings from "../cloudflare/CloudflareProviderSettings.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();
</script>

<GitHubConnect {serverId} />
<CloudflareProviderSettings {serverId} />
