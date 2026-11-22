<script lang="ts">
  /** The private card of `request_secret` (docs/plans/webhooks.md §3.6): one
   *  field per secret; the user saves or declines each one. A `file` secret is
   *  saved where the agent's commands can read it, and the card says so. The values live only
   *  in this card's local state: they are never echoed, never kept in a draft or
   *  in the transcript, and they go to the host once through
   *  `secretRequestAnswer`. The host closes the card with `permission_resolved`. */
  import { ArrowUpRight as ArrowUpRightIcon, Eye as ShowIcon, Globe as GlobeIcon, EyeOff as HideIcon, LockKeyhole as LockIcon, SquareTerminal as TerminalIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { webLinkIcon } from "@solus/client-core/web-link-icon";
  import type { QuestionRequest } from "@solus/contracts/types";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import InterruptCard from "./InterruptCard.svelte";
  import { canSubmitSecrets, SECRET_PLACEHOLDER, secretAnswer, secretPrivacyNote, secretRequestLink, secretRequestPrompts, type SecretField } from "@solus/contracts/secret-request";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    /** Answers for another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, values: (string | null)[]) => Promise<boolean>;
  }
  let { tabId, request, answer }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const prompts = $derived(secretRequestPrompts(request));
  const isGroup = $derived(prompts.length > 1);

  // One field per secret. Callers key the card by request, so it is set once.
  let fields = $state<SecretField[]>(untrack(() => prompts.map(() => ({ value: "", isDeclined: false }))));
  // Shows a field's value so the user can check what they entered. Local to the card.
  let revealed = $state<boolean[]>(untrack(() => prompts.map(() => false)));
  // A site without a favicon shows the globe.
  const failedFavicons = new SvelteSet<string>();
  let isSending = $state(false);
  let responded = $state(false);
  const closed = $derived(responded || !!request.expired);

  async function send(values: (string | null)[]) {
    if (isSending || closed) return;
    isSending = true;
    try {
      const ctx = session.ctxFor(tabId);
      const accepted = answer
        ? await answer(request.questionId, values)
        : await session.apiFor(tabId).secretRequestAnswer(ctx.session.sessionId, request.questionId, values);
      if (!accepted) {
        toasts.error("This request is no longer open");
        return;
      }
      responded = true;
      requestInputFocus();
    } catch (error) {
      toasts.error("Could not send the answer", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      // No value is kept after a send, also after a failed send.
      for (const field of fields) field.value = "";
      revealed.fill(false);
      isSending = false;
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (canSubmitSecrets(fields)) void send(secretAnswer(fields));
  }

  function toggleDeclined(field: SecretField, index: number) {
    field.isDeclined = !field.isDeclined;
    // A declined secret keeps no value.
    field.value = "";
    revealed[index] = false;
  }

  function toggleRevealed(index: number, inputId: string) {
    revealed[index] = !revealed[index];
    document.getElementById(inputId)?.focus();
  }
</script>

<InterruptCard
  type="question"
  title={isGroup ? `${prompts.length} secrets requested` : "Secret requested"}
  testId="secret-request-card"
>
  {#if request.expired}
    <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
  {:else}
    <form id="secret-request-{request.questionId}" class="flex flex-col gap-4" autocomplete="off" onsubmit={submit}>
      {#each prompts as prompt, index (index)}
        {@const field = fields[index]}
        {@const inputId = `secret-request-${request.questionId}-${index}`}
        {@const link = secretRequestLink(prompt)}
        {#if index > 0}
          <div class="h-px bg-(--border) opacity-60"></div>
        {/if}
        <div class="flex min-w-0 flex-col gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <label for={inputId} class="text-transcript-card font-medium">{prompt.name}</label>
            <p class="m-0 text-transcript-meta text-(--muted-foreground) wrap-anywhere">{prompt.reason}</p>
            {#if link}
              {@const icon = webLinkIcon(link.href)}
              <a
                href={link.href}
                title={link.href}
                class="group mt-1 inline-flex w-fit max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-sm text-transcript-meta font-medium text-(--foreground) outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-tx-focus-ring)"
                onclick={(event) => {
                  event.preventDefault();
                  void localApi.openExternal(link.href);
                }}
              >
                {#if icon?.kind === "favicon" && !failedFavicons.has(icon.url)}
                  <img
                    class="size-3.5 shrink-0 rounded-[3px] object-contain"
                    src={icon.url}
                    alt=""
                    width="14"
                    height="14"
                    referrerpolicy="no-referrer"
                    onerror={() => failedFavicons.add(icon.url)}
                  />
                {:else}
                  <GlobeIcon size={14} class="shrink-0 text-(--muted-foreground)" />
                {/if}
                <span class="truncate underline decoration-(--border) underline-offset-[3px] group-hover:decoration-current">{link.host}</span>
                <ArrowUpRightIcon size={14} class="shrink-0 text-(--muted-foreground) group-hover:text-(--foreground)" />
              </a>
            {/if}
          </div>
          {#if field.isDeclined}
            <div class="flex min-w-0 items-center justify-between gap-2">
              <p class="m-0 text-transcript-meta text-(--muted-foreground)">Declined. The agent does not get this secret.</p>
              <button
                type="button"
                class="interrupt-link"
                disabled={closed || isSending || !canDrive}
                aria-label="Undo decline of {prompt.name}"
                onclick={() => toggleDeclined(field, index)}
              >
                Undo
              </button>
            </div>
          {:else}
            <!-- The question card's own-words bar: the field, Show, and the save inside one hairline. -->
            <div class="interrupt-bar">
              <div class="min-w-0 flex-1">
                <Input
                  id={inputId}
                  bind:value={field.value}
                  type={revealed[index] ? "text" : "password"}
                  dictation={false}
                  autocomplete="off"
                  spellcheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  placeholder={SECRET_PLACEHOLDER}
                  disabled={closed || isSending || !canDrive}
                  aria-describedby="{inputId}-note"
                  class="h-7 rounded-none border-0 bg-transparent p-0 focus-visible:ring-0 pointer-coarse:h-9"
                />
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                class="shrink-0 text-(--muted-foreground) pointer-coarse:tap-area"
                disabled={closed || isSending || !canDrive}
                aria-controls={inputId}
                aria-pressed={revealed[index]}
                aria-label="{revealed[index] ? 'Hide' : 'Show'} {prompt.name}"
                title={revealed[index] ? "Hide secret" : "Show secret"}
                onclick={() => toggleRevealed(index, inputId)}
              >
                {#if revealed[index]}<HideIcon size={16} />{:else}<ShowIcon size={16} />{/if}
              </Button>
              {#if !isGroup}
                <button type="submit" class="interrupt-send" disabled={closed || isSending || !canDrive || !canSubmitSecrets(fields)}>Save securely</button>
              {/if}
            </div>
            <div class="flex min-w-0 items-center justify-between gap-3">
              <p id="{inputId}-note" class="m-0 flex min-w-0 items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
                {#if prompt.delivery === "file"}
                  <TerminalIcon size={14} class="shrink-0" />
                {:else}
                  <LockIcon size={14} class="shrink-0" />
                {/if}
                {secretPrivacyNote(prompt)}
              </p>
              <button
                type="button"
                class="interrupt-link shrink-0"
                disabled={closed || isSending || !canDrive}
                aria-label="Decline {prompt.name}"
                onclick={() => (isGroup ? toggleDeclined(field, index) : void send([null]))}
              >
                Decline
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </form>
  {/if}
  {#snippet footer()}
    {#if !request.expired && isGroup}
      <div class="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={closed || isSending || !canDrive}
          onclick={() => void send(fields.map(() => null))}
        >
          Decline all
        </Button>
        <Button
          size="sm"
          type="submit"
          form="secret-request-{request.questionId}"
          disabled={closed || isSending || !canDrive || !canSubmitSecrets(fields)}
        >
          Save securely
        </Button>
      </div>
    {/if}
  {/snippet}
</InterruptCard>
