<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { Folder as FolderIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from '../../contexts'
  import { requestExpiryText, type AgentId, type PermissionRequest, type PermissionOption } from '@solus/contracts/types'
  import { abbreviateHome } from '../../lib/paths'
  import CopyButton from '../ui/CopyButton.svelte'
  import { TerminalOutput } from '../ui/terminal-output'
  import { fileChangePreviews } from './lib/fileChangePreview'
  import {
    formatWaiting,
    permissionArgv,
    permissionCwd,
    permissionFooterOrder,
    permissionScope,
    othersTurnTitle,
    permissionKicker,
    splitPathTail,
  } from './lib/interrupt'
  import { presenceStore } from '../../contexts/presence/presence.store.svelte'
  import { canDriveSession } from '../../contexts/sharing/resource-roles'
  import { othersTurnLabel } from '../presence/lib/actor-name'
  import { formatReleaseTime } from './lib/queued-prompts'
  import InterruptCard from './InterruptCard.svelte'
  import { liveActivityClock } from '../../lib/shared-clock'
  import { conversationIsVisible } from './lib/conversation-visibility'
  import { z } from 'zod'
  import { runHost } from '../../contexts/workspace/run-location'

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
    /** The agent that asks; unset, the tab's own run. */
    provider?: AgentId | null
    /** Whether the card's global keys act. Off while the tab holds a request of
     *  its own, so one keystroke never answers two cards. */
    shortcuts?: boolean
  }

  let { tabId, permission, queueLength = 1, respond, cwd: runCwd, provider = null, shortcuts = true }: Props = $props()

  const session = getWorkspaceContext()
  const sess = $derived(session.sessionFor(tabId))
  // A member who may only read the session sees the request, not the answers.
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"))
  let responded = $state(false)
  // The host closed it unanswered (its run ended), or this click was sent.
  const closed = $derived(responded || !!permission.expired)
  // A session holding on a permission is *waiting*, and the eyebrow says how long
  // it has held — the same clock the question card runs.
  let askedAt = $state(Date.now())
  let now = $state(Date.now())
  let detailsOpen = $state(false)
  // The pill under the pointer or focus, whose scope reads beside the row.
  let hintedOptionId = $state<string | null>(null)

  $effect(() => {
    void permission.questionId
    responded = false
    detailsOpen = false
    hintedOptionId = null
    askedAt = Date.now()
  })

  const onScreen = conversationIsVisible()
  $effect(() => {
    if (closed || !onScreen()) return
    return liveActivityClock.subscribe((value) => { now = value })
  })

  const agentName = $derived((provider ?? sess?.run.provider) === 'codex' ? 'Codex' : 'Claude')
  const isEdit = $derived(permission.toolTitle === 'Edit')
  const isWrite = $derived(permission.toolTitle === 'Write')
  const input = $derived(permission.toolInput)
  const editChanges = $derived(fileChangePreviews(input))
  const hasEditStringDetails = $derived.by(() => {
    const parsed = editStringDetailsSchema.safeParse(input)
    return parsed.success && (parsed.data.old_string !== undefined || parsed.data.new_string !== undefined)
  })

  // The full argv is the hero and is never truncated — approving a command you
  // can't fully read is the failure mode this card exists to prevent.
  const argv = $derived(permissionArgv(permission))
  const kicker = $derived(permissionKicker(permission))
  // Anyone may answer (D2); a teammate's turn says whose it is.
  const othersTurn = $derived(othersTurnLabel(permission.turnAuthor, sess ? presenceStore.currentUserId(runHost(sess.run)) : null))
  const eyebrow = $derived(othersTurn ? othersTurnTitle(kicker.title, othersTurn) : `${agentName} asks for permission`)
  const cwd = $derived(runCwd || permissionCwd(permission, sess))
  // The worktree name is what the user identifies the run by; the head waits in the chip's tooltip and in Details.
  const cwdParts = $derived(cwd ? splitPathTail(abbreviateHome(cwd)) : null)
  const waiting = $derived(formatWaiting(now - askedAt))
  // Escape hatch left, affirmative right. Never the reverse, on any interrupt.
  const actions = $derived(permissionFooterOrder(permission.options))
  const hinted = $derived(permission.options.find((o) => o.optionId === hintedOptionId) ?? null)
  const hintedScope = $derived(hinted ? permissionScope(hinted.optionId, permission.toolTitle, agentName) : '')

  function handleOption(optionId: string) {
    if (closed) return
    responded = true
    if (respond) respond(permission.questionId, optionId)
    else void session.controls.respondPermission(tabId, permission.questionId, optionId).then((answered) => { if (!answered) responded = false })
  }

  function classFor(option: PermissionOption): string {
    // The narrowest grant gets the filled pill; Deny is text; broader grants stay quiet.
    if (option === actions.affirmative) return 'interrupt-pill is-filled'
    if (option === actions.escape) return 'interrupt-pill is-text is-deny'
    return 'interrupt-pill'
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
  title={eyebrow}
  tone={kicker.tone === 'destructive' ? 'destructive' : 'neutral'}
  testId="permission-card"
>
  {#snippet rail()}
    {#if permission.guestTurn}<span data-testid="permission-guest-turn">Guest turn · Ask mode</span>{/if}
    {#if queueLength > 1}<span>1 of {queueLength}</span>{/if}
    <button type="button" class="interrupt-link" aria-expanded={detailsOpen} onclick={() => (detailsOpen = !detailsOpen)}>Details</button>
    <span>{waiting}</span>
  {/snippet}

  <div class="flex flex-col gap-1">
    <p class="interrupt-title">
      {kicker.title}
      {#if cwdParts}
        <span class="text-(--muted-foreground)">in</span>
        <span class="interrupt-chip" title={cwdParts.head + cwdParts.tail}><FolderIcon size={11} />{cwdParts.tail}</span>
      {/if}
    </p>
    {#if kicker.tone === 'destructive'}
      <p class="m-0 text-transcript-meta text-destructive">
        Matches a destructive command pattern — its effects can reach outside the worktree.
      </p>
    {/if}
  </div>

  {#if argv}
    <!-- The command in the terminal it will run in, verbatim: approving a
         command you can't read whole is the failure mode this card exists
         to prevent, so it scrolls sideways rather than re-flowing, and no
         line is read as a result. -->
    <div class="interrupt-term">
      <span class="interrupt-term-prompt" aria-hidden="true">$</span>
      <div class="min-w-0 flex-1 pr-6">
        <TerminalOutput
          output={argv.text}
          label={`${argv.label} command`}
          copyable={false}
          frameless
          wrap={false}
          tones={false}
        />
      </div>
      <span class="interrupt-term-copy"><CopyButton text={argv.text} title="Copy command" /></span>
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

  <!-- Ids live behind the Details link in the eyebrow, never in a dump that
       steals the card's height from the decision itself. -->
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

  {#snippet footer()}
    {#if permission.expired}
      <div class="flex justify-end"><span class="text-transcript-meta text-(--muted-foreground)" data-testid="permission-expired">{requestExpiryText(permission.expired)}</span></div>
    {:else if !canDrive}
      <div class="flex justify-end"><span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span></div>
    {:else}
      <!-- One row: what the hinted grant means on the left, the pills on the right. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2" onmouseleave={() => (hintedOptionId = null)}>
        <p
          class="m-0 min-w-0 flex-1 text-transcript-meta text-(--muted-foreground) transition-opacity duration-150"
          class:opacity-0={!hintedScope}
          aria-live="polite"
        >{hintedScope}</p>
        <div class="flex items-center gap-1 max-[30rem]:w-full max-[30rem]:flex-col-reverse max-[30rem]:items-stretch">
          {#if actions.escape}
            <button
              type="button"
              class={classFor(actions.escape)}
              disabled={closed}
              data-testid="permission-option"
              data-kind="deny"
              onmouseenter={() => (hintedOptionId = actions.escape!.optionId)}
              onfocus={() => (hintedOptionId = actions.escape!.optionId)}
              onclick={() => handleOption(actions.escape!.optionId)}
            >
              {actions.escape.label}
              <span class="interrupt-key">esc</span>
            </button>
          {/if}
          {#each actions.middle as option (option.optionId)}
            <button
              type="button"
              class={classFor(option)}
              disabled={closed}
              data-testid="permission-option"
              data-kind="other"
              onmouseenter={() => (hintedOptionId = option.optionId)}
              onfocus={() => (hintedOptionId = option.optionId)}
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
              onmouseenter={() => (hintedOptionId = actions.affirmative!.optionId)}
              onfocus={() => (hintedOptionId = actions.affirmative!.optionId)}
              onclick={() => handleOption(actions.affirmative!.optionId)}
            >
              {actions.affirmative.label}
              <span class="interrupt-key">⏎</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}
  {/snippet}
</InterruptCard>
