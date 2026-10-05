<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from '../../contexts'
  import { requestExpiryText, type PermissionRequest, type PermissionOption } from '@solus/contracts/types'
  import { abbreviateHome, truncateMiddle } from '../../lib/paths'
  import CopyButton from '../ui/CopyButton.svelte'
  import { fileChangePreviews } from './lib/fileChangePreview'
  import {
    formatWaiting,
    permissionArgv,
    permissionCwd,
    permissionFooterOrder,
    othersTurnTitle,
    permissionKicker,
    splitPathTail,
  } from './lib/interrupt'
  import { presenceStore } from '../../contexts/presence/presence.store.svelte'
  import { canDriveSession } from '../../contexts/sharing/session-drive'
  import { othersTurnLabel } from '../presence/lib/actor-name'
  import { formatReleaseTime } from './lib/queued-prompts'
  import InterruptCard from './InterruptCard.svelte'
  import { liveActivityClock } from '../../lib/shared-clock'
  import { conversationIsVisible } from './lib/conversation-visibility'
  import { z } from 'zod'

  const editStringDetailsSchema = z.object({
    old_string: z.string().optional(),
    new_string: z.string().optional(),
  })

  interface Props {
    tabId: string
    permission: PermissionRequest
    queueLength?: number
    /** Answers for another session — a child this conversation sent work to.
     *  Unset, the answer goes to this tab's own session. */
    respond?: (questionId: string, optionId: string) => void
    /** The other session's directory, where the request runs. */
    cwd?: string
    /** Whether the card's global keys act. Off while the tab holds a request of
     *  its own, so one keystroke never answers two cards. */
    shortcuts?: boolean
  }

  let { tabId, permission, queueLength = 1, respond, cwd: runCwd, shortcuts = true }: Props = $props()

  const session = getWorkspaceContext()
  const sess = $derived(session.sessionFor(tabId))
  // A member who may only read the session sees the request, not the answers.
  const canDrive = $derived(canDriveSession(sess?.run.serverId, sess?.id))
  let responded = $state(false)
  // The host closed it unanswered (its run ended), or this click was sent.
  const closed = $derived(responded || !!permission.expired)
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

  const onScreen = conversationIsVisible()
  $effect(() => {
    if (closed || !onScreen()) return
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
  // Anyone may answer (D2); a teammate's turn says whose it is.
  const title = $derived(othersTurnTitle(kicker.title, othersTurnLabel(permission.turnAuthor, sess ? presenceStore.currentUserId(sess.run.serverId) : null)))
  const cwd = $derived(runCwd || permissionCwd(permission, sess))
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
    if (closed) return
    responded = true
    if (respond) respond(permission.questionId, optionId)
    else void session.controls.respondPermission(tabId, permission.questionId, optionId).then((answered) => { if (!answered) responded = false })
  }

  function classFor(option: PermissionOption): string {
    // The narrowest grant gets the filled action; broader grants stay quiet.
    if (option === actions.affirmative) return 'tx-card-action is-filled'
    if (option === actions.escape) return 'tx-card-action is-ghost'
    return 'tx-card-action'
  }

  /** The key hints are the card's contract, so they act rather than decorate. */
  function handleKeydown(e: KeyboardEvent) {
    if (!shortcuts || !canDrive || tabId !== session.activeTabId || closed) return
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
  <ContentSkeleton label="Loading preview" />
{/snippet}

<InterruptCard
  type="permission"
  {title}
  target={cwdParts ? `${cwdParts.head}${cwdParts.tail}` : undefined}
  tone={kicker.tone === 'destructive' ? 'destructive' : 'neutral'}
  testId="permission-card"
>
  {#snippet rail()}
    {#if queueLength > 1}<span>1 of {queueLength}</span>{/if}
    <span>{waiting}</span>
  {/snippet}

  <div
    class="flex flex-col gap-2.5"
  >
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
            <span class="shrink-0 text-transcript-meta text-(--muted-foreground)">{change.kind}</span>
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
    {#if permission.expired}
      <span class="text-transcript-meta text-(--muted-foreground)" data-testid="permission-expired">{requestExpiryText(permission.expired)}</span>
    {:else if !canDrive}
      <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
    {:else}
    {#if actions.escape}
      <button
        type="button"
        class={classFor(actions.escape)}
        disabled={closed}
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
        disabled={closed}
        data-testid="permission-option"
        data-kind="other"
        onclick={() => handleOption(option.optionId)}
      >
        {option.label}
      </button>
    {/each}
    {#if actions.affirmative}
      <button
        type="button"
        class={classFor(actions.affirmative)}
        disabled={closed}
        data-testid="permission-option"
        data-kind="allow"
        onclick={() => handleOption(actions.affirmative!.optionId)}
      >
        {actions.affirmative.label}
        <span class="interrupt-key">⏎</span>
      </button>
    {/if}
    {/if}
  {/snippet}
</InterruptCard>
