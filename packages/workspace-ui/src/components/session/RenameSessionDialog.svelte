<script lang="ts">
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import { getWorkspaceContext } from "../../contexts";
  import { sessionTitle } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    /** Tab whose session is being named. */
    tabId: string;
    onClose: () => void;
  }

  let { tabId, onClose }: Props = $props();

  const session = getWorkspaceContext();

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));

  // Seeded from what the tab currently shows, so clearing the field is an
  // explicit "go back to the prompt-derived name" rather than the default.
  let value = $state(sess ? sessionTitle(sess) : "");

  function close(): void {
    onClose();
    requestInputFocus();
  }

  function save(): void {
    void session.renameTab(tabId, value);
    close();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-start justify-center pt-[18vh] pointer-events-auto bg-transparent"
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
    class="w-[clamp(18rem,38vw,26rem)] max-w-[calc(100vw-3rem)] flex flex-col gap-3 rounded-2xl text-workspace-chrome border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-[1.125rem] shadow-[var(--solus-popover-shadow)]"
    role="dialog"
    aria-label="Rename session"
    aria-modal="true"
  >
    <div class="flex flex-col gap-1">
      <span class="font-medium">Rename session</span>
      <span class="text-xs text-(--solus-text-tertiary)">
        Leave empty to fall back to the first prompt.
      </span>
    </div>
    <Input
      bind:value
      autofocus
      placeholder="Session name"
      aria-label="Session name"
      onSubmit={save}
      submitOn="enter"
    />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
      <Button size="sm" onclick={save}>Rename</Button>
    </div>
  </div>
</div>
