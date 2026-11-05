<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
  import { getWorkspaceContext } from "../../contexts";
  import { sessionPullRequestsStore } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { sessionTitle } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import { GitPullRequest as GitPullRequestIcon, X as XIcon } from "@lucide/svelte";
  import { prStatusBadge } from "../prs/lib/pr-utils";
  import { checkPullRequestUrl, linkedPullRequestTitle, taskPullRequestLink } from "./lib/link-pull-request";

  /**
   * Link a pull request by its URL, to a session or to a task. A session owns
   * its link and its task reads it; a link on a task is for a pull request
   * that no session of the task made (docs/plans/session-pull-requests.md).
   * A session's dialog also lists its links, drawn as the sidebar chip's list
   * draws them, each with an unlink button: PR sync does not link an unlinked
   * pull request again.
   */
  interface Props {
    owner: { kind: "session"; tabId: string } | { kind: "task"; taskId: string };
    onClose: () => void;
  }

  let { owner, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(owner.kind === "session" ? session.sessionFor(owner.tabId) : null);
  const task = $derived(owner.kind === "task" ? session.tasksStore.peek(owner.taskId) : null);
  const ownerLabel = $derived(
    owner.kind === "session" ? (sess ? sessionTitle(sess) : "Session") : (task?.title ?? "Task"),
  );

  const links = $derived(sess ? sessionPullRequestsStore.linksFor(sess.id) : []);

  let value = $state("");
  let inputRef = $state<HTMLElement | null>(null);
  let saving = $state(false);
  const check = $derived(checkPullRequestUrl(value));

  function close(): void {
    onClose();
    requestInputFocus();
  }

  async function unlink(link: SessionPullRequestLink): Promise<void> {
    if (owner.kind !== "session") return;
    try {
      await sessionPullRequestsStore.unlink(session.serverIdFor(owner.tabId), link);
    } catch (error) {
      toasts.error("Couldn't unlink the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    // The row and its button are gone; the URL field keeps the dialog's keys.
    inputRef?.focus();
  }

  async function save(): Promise<void> {
    if (check.kind !== "valid" || saving) return;
    saving = true;
    try {
      if (owner.kind === "session") {
        const sessionId = sess ? sess.id : null;
        if (!sessionId) throw new Error("The session is not available.");
        await sessionPullRequestsStore.link(session.serverIdFor(owner.tabId), sessionId, check.url);
      } else {
        const link = taskPullRequestLink(check.url);
        if (!link) throw new Error("The URL is not a pull request.");
        await session.tasksStore.get(owner.taskId).link(link);
      }
      close();
    } catch (error) {
      toasts.error("Couldn't link the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving = false;
    }
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="pointer-events-auto fixed inset-0 z-[10008] flex items-start justify-center modal-backdrop pt-[18vh]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }}
>
  <div
    class="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-[1.125rem] text-workspace-chrome shadow-[var(--solus-popover-shadow)]"
    role="dialog"
    aria-label={links.length ? "Pull requests" : "Link pull request"}
    aria-modal="true"
  >
    <div class="flex flex-col gap-0.5">
      <span class="font-medium">{links.length ? "Pull requests" : "Link pull request"}</span>
      <span class="truncate text-xs text-(--solus-text-tertiary)">{ownerLabel}</span>
    </div>
    {#if links.length}
      <ul class="-mx-1.5 flex flex-col" aria-label="Linked pull requests">
        {#each links as link (`${link.repository}#${link.number}`)}
          {@const badge = prStatusBadge(link.snapshot ?? null)}
          {@const StateIcon = badge?.Icon ?? GitPullRequestIcon}
          <li
            class="group/pr flex h-8 items-center gap-2 rounded-lg px-1.5 transition-colors duration-100 hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-within:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]"
            title={link.url}
          >
            <span class="flex size-4 shrink-0 items-center justify-center" style:color={badge?.tone ?? "var(--muted-foreground)"} aria-hidden="true">
              <StateIcon size={14} />
            </span>
            {#if badge}<span class="sr-only">{badge.label}</span>{/if}
            <span class="min-w-0 flex-1 truncate">{linkedPullRequestTitle(link)}</span>
            <span class="shrink-0 tabular-nums text-muted-foreground">#{link.number}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover/pr:opacity-100 focus-visible:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
              aria-label={`Unlink pull request #${link.number}`}
              title="Unlink"
              onclick={() => void unlink(link)}
            >
              <XIcon size={13} aria-hidden="true" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex items-center gap-2">
      <Input
        bind:value
        bind:ref={inputRef}
        autofocus
        class="min-w-0 flex-1"
        placeholder="Paste a pull request URL"
        aria-label="Pull request URL"
        aria-invalid={check.kind === "invalid"}
        onSubmit={() => void save()}
        submitOn="enter"
      />
      <Button size="sm" class="shrink-0" disabled={check.kind !== "valid" || saving} onclick={() => void save()}>
        {saving ? "Linking…" : "Link"}
      </Button>
    </div>
    {#if check.kind !== "empty"}
      <span class="-mt-1 text-xs {check.kind === 'invalid' ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">
        {check.kind === "invalid" ? "Paste the full URL of a GitHub pull request." : check.label}
      </span>
    {/if}
  </div>
</div>
