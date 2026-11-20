<script lang="ts">
  import {
    PrUrlInspectionStore,
    type PrUrlState,
  } from '@solus/client-core/pr-social';
  import { serverConnections } from '@solus/client-core/server-connections';
  import { localApi } from '@solus/client-core/local-api';
  import { taskHostId } from '../../contexts/tasks/task-sources.store.svelte';
  import { getSettingsContext } from '../../contexts';
  import { githubMediaRepository } from '@solus/contracts/github-media';
  import { setGithubMediaLocation } from '../github-markdown/lib/github-media.svelte';
  import { Dialog } from 'bits-ui';
  import CommentMarkdown from '../github-markdown/CommentMarkdown.svelte';
  let { serverId = null }: { serverId?: string | null } = $props();
  const settings = getSettingsContext();
  let open = $state(false);
  let urlInput = $state<HTMLInputElement | null>(null);
  let url = $state('');
  let snapshot = $state<PrUrlState>({
    value: null,
    pending: false,
    error: null,
  });
  const store = new PrUrlInspectionStore(() => {
    const hostId = serverId ?? taskHostId();
    if (!hostId) throw new Error('Connect a host to inspect this PR.');
    return serverConnections.apiFor(hostId);
  });
  setGithubMediaLocation(() => ({
    serverId: serverId ?? taskHostId(),
    repository: snapshot.value
      ? githubMediaRepository(snapshot.value.overview.pullRequest.baseRepo)
      : undefined,
  }));
  $effect(() => {
    const accountKey = settings.personal.accountKey;
    const hostId = serverId;
    store.close();
    url = '';
    open = false;
    return () => {
      if (settings.personal.accountKey !== accountKey || serverId !== hostId)
        store.close();
    };
  });
  $effect(() => {
    if (!open) store.close();
  });
  $effect(() => {
    const off = store.subscribe(() => (snapshot = store.current));
    return () => {
      off();
      store.close();
    };
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger
    class="h-7 shrink-0 rounded-md px-2 text-workspace-chrome text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-12"
    >Inspect URL</Dialog.Trigger
  >
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop" />
    <Dialog.Content
      data-solus-ui
      class="no-drag fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border border-border bg-popover p-6 text-workspace-chrome text-popover-foreground shadow-(--solus-popover-shadow)"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        urlInput?.focus();
      }}
    >
      <div class="flex items-center gap-3">
        <Dialog.Title class="flex-1 font-medium">Inspect a PR URL</Dialog.Title
        ><Dialog.Close class="rounded-md px-2 py-1 hover:bg-muted"
          >Close</Dialog.Close
        >
      </div>
      <Dialog.Description class="text-sm text-muted-foreground"
        >Read a GitHub PR without adding a project or preparing a checkout.</Dialog.Description
      >
      <form
        class="flex gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void store.open(url);
        }}
      >
        <input
          bind:this={urlInput}
          type="url"
          name="pr-url"
          aria-label="PR URL"
          bind:value={url}
          maxlength={2048}
          class="min-w-0 flex-1 rounded-md border border-input bg-transparent p-2"
          placeholder="Paste a GitHub PR URL"
        /><button
          type="submit"
          class="rounded-md px-3 py-2 hover:bg-muted"
          disabled={snapshot.pending || !url.trim()}
          >{snapshot.pending
            ? 'Opening…'
            : snapshot.error
              ? 'Retry'
              : snapshot.value
                ? 'Refresh'
                : 'Inspect'}</button
        >
      </form>
      {#if snapshot.error}<p role="alert" class="mt-2 text-destructive">
          {snapshot.error}
        </p>{/if}
      {#if snapshot.value}{@const value = snapshot.value}{@const pr =
          value.overview.pullRequest}
        <article
          class="grid min-h-0 gap-3 overflow-y-auto rounded-lg bg-muted p-4"
        >
          <div class="flex gap-2">
            <h2 class="flex-1 font-medium">#{pr.number} {pr.title}</h2>
            <button
              type="button"
              class="rounded-md px-2 hover:bg-background"
              onclick={() => store.close()}>Clear</button
            >
          </div>
          <p class="text-sm text-muted-foreground">
            Read-only · {pr.state} · {pr.baseRepo.owner}/{pr.baseRepo.repo}.
            This does not add a project.
          </p>
          {#if value.truncated}<p class="text-sm text-muted-foreground">
              Some content is not shown. Open on GitHub to read the full
              conversation.
            </p>{/if}
          <CommentMarkdown source={pr.body} policy="remote" lineBreaks={true} />
          {#each value.comments as comment (comment.id)}{#if comment.kind !== 'label'}<section
                class="border-t border-border pt-2"
              >
                <p class="text-sm text-muted-foreground">{comment.author}</p>
                <CommentMarkdown
                  source={comment.body}
                  policy="remote"
                  lineBreaks={true}
                />
              </section>{/if}{/each}
          {#each value.threads as thread (thread.id)}{#each thread.comments as comment (comment.id)}<section
                class="border-t border-border pt-2"
              >
                <p class="text-sm text-muted-foreground">
                  {comment.author} · Inline comment
                </p>
                <CommentMarkdown
                  source={comment.body}
                  policy="remote"
                  lineBreaks={true}
                />
              </section>{/each}{/each}
          <button
            type="button"
            class="justify-self-start rounded-md px-3 py-2 hover:bg-background"
            onclick={() => void localApi.openExternal(pr.url)}
            >Open on GitHub</button
          >
        </article>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
