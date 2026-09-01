<script lang="ts">
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import CloudflareProviderSettings from "../cloudflare/CloudflareProviderSettings.svelte";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();
</script>

<!-- Ordered by what the account is for: the code and issue providers, then the
     document providers, then the deployment target. -->
<GitHubConnect {serverId} />
<AtlassianProviderSettings {serverId} />
<GoogleProviderSettings {serverId} />
<CloudflareProviderSettings {serverId} />
