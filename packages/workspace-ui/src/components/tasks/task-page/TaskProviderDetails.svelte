<script lang="ts">
  import type { Issue } from '@solus/contracts/task-types';
  import type { PrReactions } from '@solus/contracts/pr-social';
  import type { TaskProviderData, TaskProviderMetadata } from '@solus/contracts/task-data';
  import PrReactionBar from '../../prs/PrReactionBar.svelte';
  let {
    task,
    reactions,
    value,
    metadata,
    onOpenExternal,
  }: {
    task: Issue;
    /** The reactions on the issue itself, drawn as on a pull request. */
    reactions: PrReactions | undefined;
    value?: TaskProviderData;
    metadata?: TaskProviderMetadata;
    onOpenExternal: (url: string) => void;
  } = $props();
  const provider = $derived(value ?? metadata);
</script>

{#if task.kind === 'issue' && provider}
  <section class="grid gap-3 py-5" aria-label="Issue provider">
      <PrReactionBar targetId={null} {reactions} />
      {#if value?.unavailableReason}<p
          class="text-sm text-muted-foreground"
        >
          {value.unavailableReason}
        </p>{/if}
      {#if provider.author}<p class="text-sm text-muted-foreground">
          Opened by {provider.author}
        </p>{/if}
      {#if value?.commentsTruncated && value.comments === undefined}<p
          class="text-sm text-muted-foreground"
        >
          The provider returned only part of the comments. Open the provider to
          read all comments.
        </p>{/if}
      {#if provider.pullRequests.length}
        <h3 class="text-sm font-medium">Provider pull requests</h3>
        {#each provider.pullRequests as pr (pr.url)}
          <button
            type="button"
            class="rounded-md p-2 text-left text-sm hover:bg-muted"
            onclick={() => onOpenExternal(pr.url)}
            >#{pr.number}
            {pr.title} · {pr.state}{pr.closesIssue
              ? ' · Closes this issue'
              : ' · References this issue'}</button
          >
        {/each}
      {/if}
  </section>
{/if}
