<script lang="ts">
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { Button } from "../ui/button";

  let { serverId }: { serverId: string } = $props();

  const workspace = getWorkspaceContext();
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? "this host");

  function connectGithub() {
    workspace.showSettings("api-access");
    connectionsNav.open(serverId);
  }
</script>

<div class="flex min-w-0 items-center gap-2.5" role="alert">
  <span class="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
    GitHub is not connected on {hostLabel}.
  </span>
  <Button type="button" variant="outline" size="sm" onclick={connectGithub}>
    Connect GitHub on {hostLabel}
  </Button>
</div>
