<script lang="ts">
  import { TaskUrlStore } from '@solus/client-core/task-data';
  import { serverConnections } from '@solus/client-core/server-connections';
  import { localApi } from '@solus/client-core/local-api';
  import { taskHostId } from '../../contexts/tasks/task-sources.store.svelte';
  import type { TaskExternalIssue } from '@solus/contracts/task-data';
  import CommentMarkdown from '../github-markdown/CommentMarkdown.svelte';
  let url = $state('');
  let result = $state<TaskExternalIssue | null>(null);
  let pending = $state(false);
  let error = $state<string | null>(null);
  const store = new TaskUrlStore();
  async function open() {
    const hostId = taskHostId();
    if (!hostId) {
      error = 'Connect a task host first.';
      return;
    }
    pending = true;
    await store.open(serverConnections.apiFor(hostId), url);
    result = store.value;
    error = store.error;
    pending = false;
  }
</script>

<details class="border-b border-border px-4 py-2 text-workspace-chrome">
  <summary class="cursor-pointer text-muted-foreground"
    >Open an issue URL</summary
  >
  <form
    class="mt-2 flex gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      void open();
    }}
  >
    <input
      name="issue-url"
      type="url"
      aria-label="Issue URL"
      bind:value={url}
      class="min-w-0 flex-1 rounded-md border border-input bg-transparent p-2"
      placeholder="Paste a provider issue URL"
    />
    <button
      type="submit"
      class="rounded-md px-3 py-2 hover:bg-muted"
      disabled={pending || !url.trim()}>{pending ? 'Opening…' : 'Open'}</button
    >
  </form>
  {#if error}<p role="alert" class="mt-2 text-sm text-destructive">
      {error}
    </p>{/if}
  {#if result}
    <article
      class="mt-3 grid max-h-[30rem] gap-3 overflow-y-auto rounded-lg bg-muted p-4"
    >
      <div class="flex gap-2">
        <h2 class="min-w-0 flex-1 font-medium">{result.details.task.title}</h2>
        <button
          type="button"
          aria-label="Close issue inspection"
          class="rounded-md p-2 hover:bg-background"
          onclick={() => {
            store.close();
            result = null;
          }}>Close</button
        >
      </div>
      <p class="text-sm text-muted-foreground">
        Read-only inspection · {result.details.task.state.name}. This does not
        add a task source.
      </p>
      <CommentMarkdown source={result.details.task.body} policy="local" />
      {#each result.details.comments as comment (comment.id)}<div
          class="border-t border-border pt-3"
        >
          <p class="mb-2 text-sm text-muted-foreground">
            {comment.externalAuthor ?? 'Author'}
          </p>
          <CommentMarkdown source={comment.body} policy="local" />
        </div>{/each}
      {#each result.inspection.events as event (event.id)}<p
          class="text-sm text-muted-foreground"
        >
          {event.actor ?? 'Provider'}
          {event.text}
        </p>{/each}
      <button
        type="button"
        class="justify-self-start rounded-md px-3 py-2 hover:bg-background"
        onclick={() => {
          if (result?.details.task.url)
            void localApi.openExternal(result.details.task.url);
        }}>Open on provider</button
      >
    </article>
  {/if}
</details>
