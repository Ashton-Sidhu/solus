<script lang="ts">
  import { CaretRightIcon } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts'
  import type { PermissionRequest, PermissionOption } from '../../../shared/types'
  import { abbreviateHome, truncateMiddle } from '../../lib/paths'
  import CopyButton from '../ui/CopyButton.svelte'
  import { fileChangePreviews } from './lib/fileChangePreview'
  import {
    formatWaiting,
    permissionArgv,
    permissionCwd,
    permissionFooterOrder,
    permissionKicker,
    splitPathTail,
  } from './lib/interrupt'
  import { formatReleaseTime } from './lib/queued-prompts'
  import InterruptCard from './InterruptCard.svelte'
  import TranscriptChip from './TranscriptChip.svelte'
  import { liveActivityClock } from '../../lib/shared-clock'
  import { z } from 'zod'

  const editStringDetailsSchema = z.object({
    old_string: z.string().optional(),
    new_string: z.string().optional(),
  })

  interface Props {
    tabId: string
    permission: PermissionRequest
    queueLength?: number
  }

  let { tabId, permission, queueLength = 1 }: Props = $props()

  const session = getWorkspaceContext()
  const sess = $derived(session.sessionFor(tabId))
  let responded = $state(false)
  // A session holding on a permission is *waiting*, and the footer says how long
  // it has held — the same clock the question card runs.
  let askedAt = $state(Date.now())
  let now = $state(Date.now())
  let detailsOpen = $state(false)

  $effect(() => {
    void permission.questionId
    responded = false
    detailsOpen = false
    askedAt = Date.now()
  })

  $effect(() => {
    if (responded) return
    return liveActivityClock.subscribe((value) => { now = value })
  })

  const isEdit = $derived(permission.toolTitle === 'Edit')
  const isWrite = $derived(permission.toolTitle === 'Write')
  const input = $derived(permission.toolInput)
  const editChanges = $derived(fileChangePreviews(input))
  const hasEditStringDetails = $derived.by(() => {
    const parsed = editStringDetailsSchema.safeParse(input)
    return parsed.success && (parsed.data.old_string !== undefined || parsed.data.new_string !== undefined)
  })
  const hasEditDetails = $derived(editChanges.length > 0 || hasEditStringDetails)

  // The full argv is the hero and is never truncated — approving a command you
  // can't fully read is the failure mode this card exists to prevent.
  const argv = $derived(permissionArgv(permission))
  const kicker = $derived(permissionKicker(permission))
  const cwd = $derived(permissionCwd(permission, sess))
  // The head can lose its middle; the worktree name never can.
  const cwdParts = $derived.by(() => {
    if (!cwd) return null
    const { head, tail } = splitPathTail(abbreviateHome(cwd))
    return { head: truncateMiddle(head, 36), tail }
  })
  const waiting = $derived(formatWaiting(now - askedAt))
  // Escape hatch left, affirmative right. Never the reverse, on any interrupt.
  const actions = $derived(permissionFooterOrder(permission.options))

  function handleOption(optionId: string) {
    if (responded) return
    responded = true
    session.respondPermission(tabId, permission.questionId, optionId)
  }

  function classFor(option: PermissionOption): string {
    // Even a destructive request keeps neutral buttons — the affirmative is the
    // card's one terracotta, and the strip carries the warning.
    if (option === actions.affirmative) return 'interrupt-btn interrupt-btn--primary'
    if (option === actions.escape) return 'interrupt-btn'
    return 'interrupt-btn interrupt-btn--secondary'
  }

  /** The key hints are the card's contract, so they act rather than decorate. */
  function handleKeydown(e: KeyboardEvent) {
    if (tabId !== session.activeTabId || responded) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target
    if (target instanceof HTMLElement) {
      const tag = target.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || target.isContentEditable) return
    }

    if (e.key === 'Enter' && actions.affirmative) {
      e.preventDefault()
      handleOption(actions.affirmative.optionId)
    } else if (e.key === 'Escape' && actions.escape) {
      e.preventDefault()
      handleOption(actions.escape.optionId)
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet loadingDiff()}
  <div class="grid min-h-16 place-items-center text-xs text-(--muted-foreground)" role="status">
    Loading preview…
  </div>
{/snippet}

<InterruptCard
  eyebrow={kicker.label}
  title={kicker.title}
  tone={kicker.tone === 'destructive' ? 'destructive' : 'neutral'}
  testId="permission-card"
>
  {#snippet chip()}
    <TranscriptChip state={kicker.tone === 'destructive' ? 'destructive' : 'warning'}>
      {kicker.chip}
    </TranscriptChip>
  {/snippet}

  {#snippet meta()}
    <span class="shrink-0">{permission.toolTitle}</span>
    {#if cwdParts}
      <span class="shrink-0 opacity-60">·</span>
      <span class="min-w-0 truncate font-mono text-xs"
        >{cwdParts.head}<span class="font-medium text-(--foreground)">{cwdParts.tail}</span></span
      >
    {/if}
    {#if queueLength > 1}
      <span class="shrink-0 opacity-60">·</span>
      <span class="shrink-0">1 of {queueLength} waiting</span>
    {/if}
  {/snippet}

  <div class="flex flex-col gap-2.5 px-[1.125rem] pt-[0.875rem] pb-4">
    {#if argv}
      <div class="interrupt-payload">
        <div class="interrupt-payload-bar">
          <span class="interrupt-payload-label">{argv.label}</span>
          <div class="flex-1"></div>
          <CopyButton text={argv.text} title="Copy command" />
        </div>
        <pre class="interrupt-payload-body">{argv.text}</pre>
      </div>
    {/if}

    {#if isEdit && editChanges.length > 0}
      {#each editChanges as change (change.path)}
        <div class="interrupt-payload">
          <div class="interrupt-payload-bar">
            <span class="interrupt-payload-label">{change.path}</span>
            <div class="flex-1"></div>
            <span class="shrink-0 text-xs text-(--muted-foreground)">{change.kind}</span>
          </div>
          <div class="max-h-[11.25rem] overflow-auto">
            {#await import('../diff/Diff.svelte')}
              {@render loadingDiff()}
            {:then diffModule}
              {@const Diff = diffModule.default}
              <Diff patch={change.diff} />
            {/await}
          </div>
        </div>
      {/each}
    {:else if isEdit && input && hasEditStringDetails}
      {@const oldStr = typeof input.old_string === 'string' ? input.old_string : ''}
      {@const newStr = typeof input.new_string === 'string' ? input.new_string : ''}
      {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
      <div class="interrupt-payload">
        <div class="interrupt-payload-bar">
          <span class="interrupt-payload-label">{filePath}</span>
        </div>
        <div class="max-h-[11.25rem] overflow-auto">
          {#await import('../diff/Diff.svelte')}
            {@render loadingDiff()}
          {:then diffModule}
            {@const Diff = diffModule.default}
            <Diff oldFile={{ name: filePath, contents: oldStr }} newFile={{ name: filePath, contents: newStr }} />
          {/await}
        </div>
      </div>
    {/if}

    {#if isWrite && input && typeof input.content === 'string'}
      {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
      {@const contents = input.content}
      <div class="interrupt-payload">
        <div class="interrupt-payload-bar">
          <span class="interrupt-payload-label">{filePath}</span>
        </div>
        <div class="max-h-[11.25rem] overflow-auto">
          {#await import('../diff/Diff.svelte')}
            {@render loadingDiff()}
          {:then diffModule}
            {@const Diff = diffModule.default}
            <Diff newFile={{ name: filePath, contents }} />
          {/await}
        </div>
      </div>
    {/if}

    <!-- Ids belong behind one disclosure, never in a dump that steals the card's
         height from the decision itself. -->
    <div class="flex flex-col gap-1.5">
      <button
        type="button"
        class="interrupt-disclosure self-start"
        aria-expanded={detailsOpen}
        onclick={() => (detailsOpen = !detailsOpen)}
      >
        <span class="interrupt-caret" class:is-open={detailsOpen}>
          <CaretRightIcon size={14} weight="bold" />
        </span>
        Request details
      </button>
      {#if detailsOpen}
        <div class="interrupt-detail-table">
          <span class="text-(--muted-foreground)">request</span><span>{permission.questionId}</span>
          <span class="text-(--muted-foreground)">tool</span><span>{permission.toolTitle}</span>
          <span class="text-(--muted-foreground)">cwd</span><span>{cwd || '—'}</span>
          <span class="text-(--muted-foreground)">requested</span><span
            >{formatReleaseTime(askedAt / 1000)} · {waiting} ago</span
          >
        </div>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    {#if actions.escape}
      <button
        type="button"
        class={classFor(actions.escape)}
        disabled={responded}
        data-testid="permission-option"
        data-kind="deny"
        onclick={() => handleOption(actions.escape!.optionId)}
      >
        {actions.escape.label}
        <span class="interrupt-key">esc</span>
      </button>
    {/if}
    <div class="flex-1"></div>
    {#each actions.middle as option (option.optionId)}
      <button
        type="button"
        class={classFor(option)}
        disabled={responded}
        data-testid="permission-option"
        data-kind="other"
        onclick={() => handleOption(option.optionId)}
      >
        {option.label}
      </button>
    {/each}
    <span class="shrink-0 text-xs text-(--muted-foreground)">
      {#if responded}
        Answered
      {:else}
        Holding · <span class="font-mono text-xs">{waiting}</span>
      {/if}
    </span>
    {#if actions.affirmative}
      <button
        type="button"
        class={classFor(actions.affirmative)}
        disabled={responded}
        data-testid="permission-option"
        data-kind="allow"
        onclick={() => handleOption(actions.affirmative!.optionId)}
      >
        {actions.affirmative.label}
        <span class="interrupt-key">⏎</span>
      </button>
    {/if}
  {/snippet}
</InterruptCard>
