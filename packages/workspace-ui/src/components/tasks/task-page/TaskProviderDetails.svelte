<script lang="ts">
  import type { Task as StoredTask } from '../../../contexts/tasks/task.svelte';
  import type { Task, TaskComment } from '@solus/contracts/task-types';
  import type { TaskProviderData, TaskReactionContent } from '@solus/contracts/task-data';
  import { parseTaskKey } from '@solus/contracts/task-sources';
  import { toasts } from '../../../lib/toasts';
  let {
    task,
    taskData,
    comments,
    value,
    readOnly = false,
    onOpenExternal,
  }: {
    task: Task;
    taskData?: StoredTask['data'];
    comments: TaskComment[];
    value?: TaskProviderData;
    readOnly?: boolean;
    onOpenExternal: (url: string) => void;
  } = $props();
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
  async function react(content: TaskReactionContent) {
    if (!taskData || readOnly) return;
    busy = true;
    try {
      const previous = value?.reactions.find(
        (reaction) =>
          reaction.targetId === selectedTarget && reaction.content === content,
      );
      await taskData.react(
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

{#if task.kind === 'issue' && value}
  <section class="grid gap-3 border-t border-border/60 py-5" aria-label="Issue provider">
      {#if value.unavailableReason}<p
          class="text-sm text-muted-foreground"
        >
          {value.unavailableReason}
        </p>{/if}
      {#if value.author}<p class="text-sm text-muted-foreground">
          Opened by {value.author}
        </p>{/if}
      {#if value.commentsTruncated}<p
          class="text-sm text-muted-foreground"
        >
          The provider returned only part of the comments. Open the provider to
          read all comments.
        </p>{/if}
      {#if taskData && !readOnly && value.capabilities.reactions}
        <label class="grid gap-1 text-sm"
          >React to
          <select
            name="reaction-target"
            class="rounded-md border border-input bg-transparent p-2"
            bind:value={targetId}
          >
            <option value="">Issue</option>
            {#each comments.filter((comment) => !comment.unsent && comment.providerCommentId) as comment (comment.id)}
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
            {@const held = value.reactions.find(
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
      {#if value.pullRequests.length}
        <h3 class="text-sm font-medium">Provider pull requests</h3>
        {#each value.pullRequests as pr (pr.url)}
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
