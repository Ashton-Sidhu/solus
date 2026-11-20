<script lang="ts">
  import type { SessionCloudReadView } from "@solus/client-core/session-cloud-read";
  import { sessionCloudReadText } from "@solus/client-core/session-cloud-read-text";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import ConversationLoading from "./ConversationLoading.svelte";
  import { knownHostLabel } from "./lib/session-sync-view";

  /**
   * A session's conversation read from Solus Cloud while no host shows it
   * (docs/plans/portable-sessions-cloud.md, Phase 5B). `pane` fills an empty
   * conversation with its state; `notice` is one line above the rows of the
   * copy. Not an error unless reading failed: the copy is read only, and the
   * composer below still sends.
   */
  let { tabId, view, placement }: { tabId: string; view: SessionCloudReadView; placement: "pane" | "notice" } = $props();

  const workspace = getWorkspaceContext();
  const sess = $derived(workspace.sessionFor(tabId));
  const hostLabel = $derived((sess && knownHostLabel(serverConnections.resolveId(runHost(sess.run)))) || "This machine");
  const text = $derived(sessionCloudReadText(view, hostLabel));

  function act(): void {
    if (text.action === "show-live") workspace.runHosts.showRunHostConversation(tabId);
    else void workspace.cloudTranscripts.reload(tabId);
    requestInputFocus({ tabId });
  }
</script>

{#snippet action()}
  {#if text.action}
    <Button variant="outline" size="xs" class="shrink-0" onclick={act}>
      {text.action === "show-newer" ? "Show newer turns" : text.action === "show-live" ? "Show it" : "Try again"}
    </Button>
  {/if}
{/snippet}

{#if placement === "pane"}
  {#if view.kind === "loading"}
    <ConversationLoading />
  {:else}
    <div class="flex h-full items-center justify-center px-6">
      <div class="flex max-w-80 flex-col items-center gap-2 text-center" role={view.kind === "error" ? "alert" : "status"}>
        <p class="m-0 text-workspace-chrome text-(--solus-text-secondary)">{text.message}</p>
        {#if text.detail}<p class="m-0 text-chrome-dense text-(--solus-text-tertiary)">{text.detail}</p>{/if}
        {@render action()}
      </div>
    </div>
  {/if}
{:else if view.kind !== "loading"}
  <div class="mt-3 flex min-w-0 items-center gap-3 rounded-lg bg-(--wash-1) px-3 py-2" role="status">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <p class="m-0 text-chrome-dense text-(--solus-text-secondary)">{text.message}</p>
      {#if text.detail}<p class="m-0 text-chrome-dense text-(--solus-text-tertiary)">{text.detail}</p>{/if}
    </div>
    {@render action()}
  </div>
{/if}
