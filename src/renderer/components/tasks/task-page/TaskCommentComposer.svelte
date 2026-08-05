<script lang="ts">
  import type { AgentId } from "../../../../shared/types";
  import { getAgentContext, getWorkspaceContext } from "../../../contexts";
  import PromptEditor from "../../ui/PromptEditor.svelte";

  interface Props {
    onSubmit: (body: string) => Promise<void>;
  }

  let { onSubmit }: Props = $props();

  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const editorProvider = $derived<AgentId>(
    (agentContext.activeMetadata?.id as AgentId) ?? "claude-code",
  );
  const editorCwd = $derived(session.tasksProjectCwd ?? undefined);

  let draft = $state("");
  let posting = $state(false);
  const canSend = $derived(draft.trim().length > 0 && !posting);

  async function send() {
    if (!canSend) return;
    posting = true;
    try {
      await onSubmit(draft.trim());
      draft = "";
    } finally {
      posting = false;
    }
  }
</script>

<!-- Sticky over the scroll region, with a scrim so rows dissolve into the canvas
     rather than being clipped by a hard edge. -->
<div
  class="sticky bottom-0 z-10 pt-2.5 pb-[22px] [background:linear-gradient(to_bottom,transparent,var(--background)_22px)]"
>
  <div
    class="rounded-[14px] bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_1px_2px_rgba(24,20,16,.05)]"
  >
    <div class="px-3.5 pt-3 pb-1">
      <PromptEditor
        value={draft}
        onValueChange={(v) => (draft = v)}
        enterInsertsNewline
        disabled={posting}
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
        maxHeight={200}
        class="text-[13px] leading-[1.7]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            void send();
          }
        }}
      />
    </div>
    <div class="flex items-center gap-2.5 border-t border-[var(--hairline)] py-2.5 pr-[11px] pl-3.5">
      <span class="flex-1"></span>
      <span class="text-[11px] text-muted-foreground opacity-75">
        {draft.trim() ? "" : "Markdown supported"}
      </span>
      <button
        type="button"
        class="flex h-[30px] cursor-pointer items-center gap-[7px] rounded-[10px] bg-primary px-[13px] text-[12.5px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-opacity duration-150 {canSend
          ? 'opacity-100'
          : 'opacity-45'}"
        onclick={send}
        disabled={!canSend}
        title="Comment (⌘↵)"
      >
        Comment
        <span class="font-mono text-[10.5px] opacity-80">⌘⏎</span>
      </button>
    </div>
  </div>
</div>
