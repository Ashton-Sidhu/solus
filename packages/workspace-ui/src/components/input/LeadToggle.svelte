<script lang="ts">
  import { Switch } from "../ui/switch";
  import type { RunConfig } from "@solus/contracts/types";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "../ui/tooltip";
  import { canChooseLead, runForLead } from "./lib/lead-toggle";

  /**
   * The Lead choice of a session that has not started
   * (docs/plans/lead-session.md): a lead coordinates workers and does not
   * implement. Offered in the composer before the first message, fixed once
   * the session starts, and shown nowhere after.
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
        <label
          {...props}
          data-testid="lead-toggle"
          class="flex h-[1.875rem] cursor-pointer items-center gap-2 rounded-lg px-2.5 font-secondary text-workspace-chrome transition-colors hover:bg-(--solus-surface-hover) {isLead ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}"
        >
          <Switch size="sm" checked={isLead} onCheckedChange={toggle} aria-label="Delegate work to other sessions" />
          <span class="font-medium whitespace-nowrap @max-[28rem]/composer:hidden">Delegate</span>
        </label>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={isLead ? "This session delegates: it splits the work across other sessions and reports back, instead of doing it itself. Fixed once the session starts." : "Delegate: split the work across other sessions and report back"} />
  </TooltipUI.Root>
{/if}
