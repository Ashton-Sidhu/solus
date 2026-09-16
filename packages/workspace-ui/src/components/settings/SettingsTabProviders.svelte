<script lang="ts">
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import CloudflareProviderSettings from "../cloudflare/CloudflareProviderSettings.svelte";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();
</script>

<!-- Ordered by what the account is for: the member's own agent logins on a shared
     host first, then the code and issue providers, then the document providers,
     then the deployment target. -->
<SeatsSettings {serverId} />
<GitHubConnect {serverId} />
<AtlassianProviderSettings {serverId} />
<GoogleProviderSettings {serverId} />
<CloudflareProviderSettings {serverId} />
