<script lang="ts">
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { Button } from "../ui/button";

  let {
    serverId,
    layout = "inline",
    message,
  }: {
    serverId: string;
    layout?: "inline" | "stacked";
    message?: string;
  } = $props();

  const workspace = getWorkspaceContext();
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? "this host");

  function connectGithub() {
    workspace.showSettings("api-access");
    connectionsNav.open(serverId);
  }
</script>

<div
  class="flex min-w-0 gap-2.5 {layout === 'stacked'
    ? 'flex-col items-center'
    : 'items-center'}"
  role="alert"
>
  <span
    class="min-w-0 flex-1 text-workspace-chrome text-muted-foreground {layout ===
    'stacked'
      ? 'text-center text-pretty'
      : ''}"
  >
    {message ?? `GitHub is not connected on ${hostLabel}.`}
  </span>
  <Button
    type="button"
    variant="outline"
    size="sm"
    class={layout === "stacked"
      ? "h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-pretty"
      : undefined}
    onclick={connectGithub}
  >
    Connect GitHub on {hostLabel}
  </Button>
</div>
