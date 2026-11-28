<script lang="ts">
  import { ACCOUNT_SETTINGS_PATHS } from "@solus/contracts/account-web";
  import { localApi } from "@solus/client-core/local-api";
  import { accountStore } from "../../contexts/account/account.store.svelte";
  import { Button } from "../ui/button";

  let { mcp = false }: { mcp?: boolean } = $props();
  const url = $derived(accountStore.state.kind === "signed-in"
    ? new URL(ACCOUNT_SETTINGS_PATHS.connections + (mcp ? "#mcp" : ""), accountStore.state.consoleUrl).href
    : undefined);
</script>

{#if url}
  <Button href={url} variant={mcp ? "link" : "outline"} size="sm" class="self-start pointer-coarse:min-h-11"
    onclick={(event) => {
      if (localApi.getPlatform() === "web") return;
      event.preventDefault();
      if (url) void localApi.openExternal(url);
    }}>
    {mcp ? "Manage account MCP credentials" : "Connections"}
  </Button>
{/if}
