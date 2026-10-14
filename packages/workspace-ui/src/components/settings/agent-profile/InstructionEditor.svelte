<script lang="ts">
  /**
   * One provider's instruction file (CLAUDE.md, AGENTS.md) as a text area.
   * The parent keys this editor by the entry's hash, so a change from another
   * device replaces the draft instead of fighting it.
   */
  import type { AgentProfileFileEntry } from "@solus/contracts/agent-profile";
  import type { SeatProvider } from "@solus/contracts/seats";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Textarea } from "../../ui/textarea";
  import { decodeFileText, encodeFileEntry, withDisabled } from "./lib/agent-profile-entries";

  interface Props {
    provider: SeatProvider;
    path: string;
    entry: AgentProfileFileEntry | null;
  }

  let { provider, path, entry }: Props = $props();

  const storedText = entry ? decodeFileText(entry) : "";
  let draft = $state(storedText);
  let saving = $state(false);
  const isDirty = $derived(draft !== storedText);

  async function save() {
    saving = true;
    try {
      // An edit keeps the file off when it was off.
      agentProfileLocalStore.setEntry(withDisabled(await encodeFileEntry(provider, path, draft), entry?.disabled === true));
    } finally {
      saving = false;
    }
    requestInputFocus();
  }

  function discard() {
    draft = storedText;
    requestInputFocus();
  }
</script>

<div class="flex flex-col gap-2">
  <Textarea
    bind:value={draft}
    rows={6}
    spellcheck={false}
    dictation={false}
    aria-label="{path} for {provider}"
    placeholder="Instructions every agent reads first."
    class="min-h-24 resize-y font-mono text-xs"
  />
  <div class="flex flex-wrap items-center justify-end gap-2">
    {#if isDirty}
      <Button variant="ghost" size="sm" disabled={saving} onclick={discard}>Discard</Button>
    {/if}
    <Button size="sm" disabled={!isDirty || saving} onclick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
  </div>
</div>
