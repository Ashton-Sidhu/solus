<script lang="ts">
  import type { AgentId } from "../../../../shared/types";
  import { getAgentContext, getWorkspaceContext } from "../../../contexts";
  import DocumentPromptEditor from "../../editor/DocumentPromptEditor.svelte";
  import { Button } from "../../ui/button";
  import { Switch } from "../../ui/switch";

  interface Props {
    /** `alsoPost` is the user's choice for this one comment; the host still
     *  decides what to do with it when the task has no ticket. */
    onSubmit: (body: string, alsoPost: boolean) => Promise<void>;
    /** The system a comment can also be posted to, when this task has one. */
    provider: string | null;
    /** The project posts every comment upstream. The choice is then not this
     *  comment's to make, so the toggle shows it on and says who set it. */
    autoPost: boolean;
  }

  let { onSubmit, provider, autoPost }: Props = $props();

  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const editorProvider = $derived<AgentId>(
    agentContext.activeMetadata?.id ?? "claude-code",
  );
  const editorCwd = $derived(session.tasksProjectCwd ?? undefined);

  let editorEl: ReturnType<typeof DocumentPromptEditor> | null = $state(null);
  let draft = $state("");
  let hasContent = $state(false);
  let posting = $state(false);
  let alsoPost = $state(false);
  const canSend = $derived(hasContent && !posting);

  async function send() {
    if (!canSend) return;
    const body = editorEl?.getMarkdown().trim() ?? draft.trim();
    if (!body) return;
    posting = true;
    try {
      await onSubmit(body, autoPost || alsoPost);
      draft = "";
      hasContent = false;
    } finally {
      posting = false;
    }
  }
</script>

<!-- Sticky over the scroll region, with a scrim so rows dissolve into the canvas
     rather than being clipped by a hard edge. The pill itself matches the PR
     composer: one row that grows with the text, the send affordance a tinted
     accent square rather than a footer bar of chrome. -->
<div
  class="sticky bottom-0 z-10 pt-2.5 pb-[22px] [background:linear-gradient(to_bottom,transparent,var(--background)_22px)]"
>
  <div
    class="flex items-end gap-3 rounded-2xl bg-card px-3.5 py-2.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_1px_2px_rgba(24,20,16,.05)] transition-shadow focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]"
  >
    <DocumentPromptEditor
      bind:this={editorEl}
      value={draft}
      onValueChange={(v) => (draft = v)}
      onInput={() => (hasContent = !(editorEl?.getEditor()?.isEmpty ?? true))}
      readOnly={posting}
      dragHandle={false}
      placeholder="Leave a comment. @ to mention, # to link a task."
      pluginCommands={session.pluginCommands}
      provider={editorProvider}
      workingDirectory={editorCwd}
      onPlanRefClick={(planId) => session.openPlanModal(planId)}
      onWorkRefClick={(workId, title) => session.openWorkModal(workId, title)}
      onPrRefClick={(number, title) =>
        void session.enterPrReview(number, title, {
          ctx: editorCwd ? session.ctxForDirectory(editorCwd) : session.ctx,
        })}
      menuPlacement="up"
      maxHeight={160}
      class="doc-prompt-compact min-w-0 flex-1"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          void send();
        }
      }}
    />
    <Button
      type="button"
      class="flex h-[28px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-[color:color-mix(in_oklab,var(--primary)_14%,transparent)] px-3 font-medium text-primary transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canSend}
      title="Comment · ⌘↵"
      onclick={send}
    >
      Comment
    </Button>
  </div>

  <!-- Where this comment goes is decided before it is sent, not after: the
       toggle sits under the composer rather than appearing as a regret. -->
  {#if provider}
    <div class="flex items-center gap-2 px-1 pt-2">
      <Switch
        size="sm"
        checked={autoPost || alsoPost}
        disabled={autoPost}
        onCheckedChange={(next) => (alsoPost = next)}
        aria-label="Also post this comment to {provider}"
      />
      <span class="text-xs text-muted-foreground">
        {autoPost
          ? `Posting to ${provider} (auto-post is on for this project)`
          : `Also post to ${provider}`}
      </span>
    </div>
  {/if}
</div>
