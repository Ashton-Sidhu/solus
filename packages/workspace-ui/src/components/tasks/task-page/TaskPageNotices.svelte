<script lang="ts">
  import { CloudOff as CloudOffIcon } from "@lucide/svelte";
  import { Button } from "../../ui/button";

  /**
   * What the reader must know before they trust the page: the provider did
   * not answer, so the page shows the host's last copy; or a dispatched
   * session wrote changes that this host does not have yet (ADR-0007).
   */
  interface Props {
    /** The detail read answered from the host's copy of the task. */
    fromCache: boolean;
    refreshing: boolean;
    onRefresh: () => void;
    /** Writes of a dispatched session that wait for this host. */
    pendingSyncCount: number;
    /** Writes of a dispatched session that this host refused. */
    failedSyncCount: number;
  }

  let { fromCache, refreshing, onRefresh, pendingSyncCount, failedSyncCount }: Props = $props();
</script>

{#if fromCache || pendingSyncCount || failedSyncCount}
  <div class="mx-auto flex w-full max-w-[1420px] flex-col gap-2 px-[52px] pt-4 @max-[60rem]:px-6 @max-[42rem]:px-4">
    {#if fromCache}
      <div
        class="flex flex-wrap items-center gap-2 rounded-md border-[.5px] border-[var(--hairline)] bg-[var(--wash-1)] px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <CloudOffIcon size={13} class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          The provider did not answer. This is the last copy on this host.
        </span>
        <Button variant="outline" size="xs" disabled={refreshing} onclick={onRefresh}>
          {refreshing ? "Reading…" : "Try again"}
        </Button>
      </div>
    {/if}
    {#if pendingSyncCount || failedSyncCount}
      <div
        class="flex items-center gap-2 rounded-md border-[.5px] border-[var(--hairline)] bg-[var(--wash-1)] px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <span
          class="size-1.5 shrink-0 rounded-full {failedSyncCount ? 'bg-(--failure)' : 'bg-(--warning)'}"
          aria-hidden="true"
        ></span>
        {#if pendingSyncCount}
          <span>
            {pendingSyncCount} update{pendingSyncCount === 1 ? "" : "s"} from a dispatched session
            waiting to sync
          </span>
        {/if}
        {#if failedSyncCount}
          <span>{failedSyncCount} update{failedSyncCount === 1 ? "" : "s"} failed to sync</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}
