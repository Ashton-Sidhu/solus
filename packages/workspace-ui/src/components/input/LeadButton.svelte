<script lang="ts">
  import { Network as LeadIcon } from "@lucide/svelte";
  import type { RunConfig } from "@solus/contracts/types";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "../ui/tooltip";
  import { canChooseLead, runForLead } from "./lib/lead-toggle";

  /**
   * Meta mode, the lead choice of a session that has not started
   * (docs/plans/lead-session.md): a lead plans the work, starts other sessions
   * to do it, and reports back. One button in the composer footer, a ghost
   * button that fills while it is selected. Offered before the first message, fixed once the
   * session starts, and shown nowhere after.
   */
  interface Props {
    tabId?: string;
    /** The draft composed for, when there is no tab yet. */
    draft?: SessionDraft;
    /** A session draft's run, edited in place through `onRun`. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    isPrimary?: boolean;
  }
  let { tabId, draft, run, onRun, isPrimary = false }: Props = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const sess = $derived(tabId ? session.sessionFor(tabId) : undefined);
  const offered = $derived(canChooseLead(sess, draft));
  const isLead = $derived(draft ? draft.isLead : (sess?.isLead ?? false));

  function toggle() {
    const next = !isLead;
    if (draft) draft.isLead = next;
    else if (sess) sess.isLead = next;
    if (next) {
      const current = run ?? draft?.run ?? sess?.run;
      if (current) {
        const started = runForLead(current, settings.leadModel);
        if (started !== current) {
          if (onRun) onRun(started);
          else if (draft) draft.applyRun(started);
          else if (sess) sess.run = started;
        }
      }
    }
    if (isPrimary) requestInputFocus();
  }
</script>

{#if offered}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <!-- The same glyph marks the session in the sidebar once it starts, so
             the button and the row say "Meta mode" the same way. A ghost
             button, quiet beside the footer's other controls; selected, it
             fills with the accent tint: the state reads by fill as well as by
             colour. -->
        <button
          {...props}
          type="button"
          data-testid="lead-toggle"
          aria-pressed={isLead}
          aria-label="Meta mode: plan the work and start other sessions to do it"
          onclick={toggle}
          class="flex h-[1.625rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 font-secondary text-workspace-chrome font-medium transition-[background-color,color,scale] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) {isLead
            ? 'bg-(--solus-accent-light) text-(--solus-accent)'
            : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
        >
          <LeadIcon size={14} class="shrink-0" />
          <span class="whitespace-nowrap @max-[22rem]/composer:hidden">Meta mode</span>
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={isLead ? "Meta mode is on: this session plans the work, starts other sessions to do it, and reports back. It does not do the work itself. Fixed once the session starts." : "Meta mode: plan the work, start other sessions to do it, and report back"} />
  </TooltipUI.Root>
{/if}
