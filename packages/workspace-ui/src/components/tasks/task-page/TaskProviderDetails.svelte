<script lang="ts">
  import type { TaskInspectionState } from '@solus/client-core/task-inspection';
  import type { Task } from '../../../contexts/tasks/task.svelte';
  import type { TaskReactionContent } from '@solus/contracts/task-inspection';
  import { parseTaskKey } from '@solus/contracts/task-sources';
  import { toasts } from '../../../lib/toasts';
  let {
    task,
    enabled = true,
    onOpenExternal,
  }: {
    task: Task;
    enabled?: boolean;
    onOpenExternal: (url: string) => void;
  } = $props();
  let inspection = $state<TaskInspectionState>({ value: null, pending: false, loadingMore: false, error: null });
  let busy = $state(false);
  const reactions: { content: TaskReactionContent; label: string }[] = [
    { content: 'THUMBS_UP', label: '👍' },
    { content: 'THUMBS_DOWN', label: '👎' },
    { content: 'LAUGH', label: '😄' },
    { content: 'HOORAY', label: '🎉' },
    { content: 'CONFUSED', label: '😕' },
    { content: 'HEART', label: '❤️' },
    { content: 'ROCKET', label: '🚀' },
    { content: 'EYES', label: '👀' },
  ];
  const issueId = $derived(parseTaskKey(task.id)?.id ?? '');
  let targetId = $state('');
  const selectedTarget = $derived(targetId || issueId);
  $effect(() => {
    const store = task.inspection;
    const off = store.subscribe(() => {
      inspection = store.current;
    });
    inspection = store.current;
    if (enabled && task.kind === 'issue') void store.refresh();
    return off;
  });
  async function react(content: TaskReactionContent) {
    busy = true;
    try {
      const previous = inspection.value?.reactions.find(
        (reaction) =>
          reaction.targetId === selectedTarget && reaction.content === content,
      );
      await task.inspection.react(
        selectedTarget,
        content,
        !previous?.viewerHasReacted,
      );
    } catch (error) {
      toasts.error('Could not change the reaction', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busy = false;
    }
  }
</script>

{#if task.kind === 'issue'}
  <section
    class="grid gap-3 border-t border-border/60 py-5"
    aria-label="Provider history"
  >
    <div class="flex items-center gap-2">
      <h2 class="min-w-0 flex-1 text-sm font-medium">Provider history</h2>
      <button
        type="button"
        class="rounded-md p-2 text-workspace-chrome text-muted-foreground hover:bg-muted pointer-coarse:min-h-12"
        disabled={inspection.pending}
        onclick={() => void task.inspection.refresh()}
        >{inspection.pending ? 'Refreshing…' : 'Refresh'}</button
      >
    </div>
    {#if inspection.error}<p class="text-sm text-destructive" role="alert">
        {inspection.error} Loaded history is retained.
      </p>{/if}
    {#if inspection.value}
      {#if inspection.value.unavailableReason}<p
          class="text-sm text-muted-foreground"
        >
          {inspection.value.unavailableReason}
        </p>{/if}
      {#if inspection.value.author}<p class="text-sm text-muted-foreground">
          Opened by {inspection.value.author}
        </p>{/if}
      {#if inspection.value.commentsTruncated}<p
          class="text-sm text-muted-foreground"
        >
          The provider returned only part of the comments. Open the provider to
          read all comments.
        </p>{/if}
      {#if inspection.value.capabilities.reactions}
        <label class="grid gap-1 text-sm"
          >React to
          <select
            name="reaction-target"
            class="rounded-md border border-input bg-transparent p-2"
            bind:value={targetId}
          >
            <option value="">Issue</option>
            {#each task.details?.comments.filter((comment) => !comment.unsent && comment.providerCommentId) ?? [] as comment (comment.id)}
              <option value={comment.providerCommentId}
                >Comment by {comment.externalAuthor ?? 'author'}: {comment.body.slice(
                  0,
                  45,
                )}</option
              >
            {/each}
          </select>
        </label>
        <div class="flex flex-wrap gap-1">
          {#each reactions as reaction (reaction.content)}
            {@const held = inspection.value.reactions.find(
              (item) =>
                item.targetId === selectedTarget &&
                item.content === reaction.content,
            )}
            <button
              type="button"
              class="min-h-9 rounded-md border border-border px-2 text-sm hover:bg-muted pointer-coarse:min-h-12"
              aria-label={reaction.content.toLowerCase().replaceAll('_', ' ')}
              aria-pressed={held?.viewerHasReacted ?? false}
              disabled={busy}
              onclick={() => void react(reaction.content)}
              >{reaction.label} {held?.count || ''}</button
            >
          {/each}
        </div>
      {/if}
      {#if inspection.value.pullRequests.length}
        <h3 class="text-sm font-medium">Provider pull requests</h3>
        {#each inspection.value.pullRequests as pr (pr.url)}
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
      <ol class="grid gap-2 text-sm text-muted-foreground">
        {#each inspection.value.events as event (event.id)}
          <li>
            <span class="text-foreground">{event.actor ?? 'Provider'}</span>
            {event.text} · {new Date(event.at).toLocaleString()}
          </li>
        {:else}
          <li>
            {inspection.pending
              ? 'Loading history…'
              : 'No provider events loaded.'}
          </li>
        {/each}
      </ol>
      {#if inspection.value.historyCursor}
        <button
          type="button"
          class="justify-self-start rounded-md border border-border px-3 py-2 text-workspace-chrome hover:bg-muted"
          disabled={inspection.loadingMore || inspection.pending}
          onclick={() => void task.inspection.loadMore()}
          >{inspection.loadingMore
            ? 'Loading…'
            : inspection.error
              ? 'Retry older history'
              : 'Load older history'}</button
        >
      {/if}
    {/if}
  </section>
{/if}
