<script lang="ts">
  import type { Snippet } from "svelte";
  import { CircleAlert as ErrorIcon, WifiOff as UnreachableIcon } from "@lucide/svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { getWorkspaceContext, serversStore } from "../../../contexts";
  import { openChatDraft } from "../../../contexts/workspace/new-chat";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../../lib/page-chrome";
  import { isHostUnreachable } from "../../../lib/sessionUtils";
  import PageEmpty from "../../ui/PageEmpty.svelte";
  import { appAddPrompt, appChangePrompt, emptyDescriptionParts, sectionErrorTitle, type ManageEmpty, type ManageEmptyAction } from "./lib/section-empty";

  /**
   * What a section of the Manage page says before it has rows: it loads, the
   * read failed, or the section is empty. The empty and the failed states are
   * `PageEmpty`: an empty section says what will show and one way to get it; a
   * failed read is muted, with Try again. With rows it draws them. It never
   * shows a loading state for a read that ended.
   */
  interface Props {
    serverId: string;
    app: Pick<AppSummary, "name" | "slug">;
    /** Undefined until the host answers. */
    count: number | undefined;
    error: string | null;
    empty: ManageEmpty;
    onRetry: () => void;
    children: Snippet;
  }
  let { serverId, app, count, error, empty, onRetry, children }: Props = $props();

  const workspace = getWorkspaceContext();
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? serverId);
  const hostUnreachable = $derived(isHostUnreachable(serversStore.readinessFor(serverId).readiness));

  function runAction(action: ManageEmptyAction) {
    if ("run" in action) action.run();
    else openChatDraft(workspace, "click", { serverId, prompt: "ask" in action ? appAddPrompt(app, action.ask) : appChangePrompt(app) });
  }
</script>

{#snippet emptyActions()}
  {#each empty.actions ?? [] as action (action.label)}
    <button type="button" class={action.secondary ? PAGE_SECONDARY_BTN : PAGE_PRIMARY_BTN} onclick={() => runAction(action)}>{action.label}</button>
  {/each}
{/snippet}

{#if count === undefined}
  {#if error}
    <div role="alert">
      <PageEmpty icon={hostUnreachable ? UnreachableIcon : ErrorIcon} tone="muted" compact title={sectionErrorTitle(hostLabel, hostUnreachable)}>
        {hostUnreachable ? "The section shows again when the host is back. Nothing is lost." : error}
        {#snippet actions()}
          <button type="button" class={PAGE_SECONDARY_BTN} onclick={onRetry}>Try again</button>
        {/snippet}
      </PageEmpty>
    </div>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading…</p>
  {/if}
{:else if count === 0}
  <PageEmpty icon={empty.icon} compact title={empty.title} actions={empty.actions?.length ? emptyActions : undefined}>
    {#each emptyDescriptionParts(empty.description) as part, index (index)}
      {#if part.isCode}<code class="font-mono text-[0.92em] text-(--solus-text-secondary)">{part.text}</code>{:else}{part.text}{/if}
    {/each}
  </PageEmpty>
{:else}
  {@render children()}
{/if}
