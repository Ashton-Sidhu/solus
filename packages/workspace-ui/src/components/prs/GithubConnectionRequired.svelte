<script lang="ts">
  import { getClientShellContext, getSurfaceContext, serversStore } from "../../contexts";
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

  // Where the connection is made is the shell's: the workspace's API access
  // settings, or the console's connections page.
  const shell = getClientShellContext();
  // A workspace can hold GitHub on one machine and not another, so it names
  // the host. The console has one host, whose label is the organization's
  // name — meaningless beside "Connect GitHub", so it is left off.
  const namesHost = getSurfaceContext().workspace !== null;
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? "this host");

  function connectGithub() {
    shell.openResource({ kind: "connections", serverId });
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
    {message ?? (namesHost ? `GitHub is not connected on ${hostLabel}.` : "GitHub is not connected.")}
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
    {namesHost ? `Connect GitHub on ${hostLabel}` : "Connect GitHub"}
  </Button>
</div>
