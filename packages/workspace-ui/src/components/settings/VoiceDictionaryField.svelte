<script lang="ts">
  import { X as XIcon } from "@lucide/svelte";
  import { VOICE_DICTIONARY_LIMIT } from "@solus/contracts/voice-dictionary";
  import { getSettingsContext } from "../../contexts";
  import { Button } from "../ui/button";
  import { SearchField } from "../ui/search-field";
  import { Textarea } from "../ui/textarea";
  import SettingsSection from "./SettingsSection.svelte";
  import { VoiceDictionaryEditor } from "./lib/voice-dictionary-editor.svelte";

  const settings = getSettingsContext();
  const editor = new VoiceDictionaryEditor(
    () => settings.voiceDictionary,
    (entries) => settings.setPersonal("voiceDictionary", entries),
  );
  let addInput: HTMLTextAreaElement | null = $state(null);
  let addText = $state("");

  function addTerms() {
    if (addText.trim() && editor.add(addText)) addText = "";
    addInput?.focus();
  }

  function onAddKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    addTerms();
  }

  function aliasInputNear(element: HTMLElement) {
    return element.closest("[data-term-row]")?.querySelector<HTMLInputElement>("[data-alias-input]");
  }

  function onTermKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }, term: string) {
    if (event.key === "Enter") aliasInputNear(event.currentTarget)?.focus();
    if (event.key !== "Escape") return;
    event.currentTarget.value = term;
    editor.clearError();
  }

  function addAlias(input: HTMLInputElement, term: string) {
    if (input.value.trim() && editor.addAlias(term, input.value)) input.value = "";
  }

  function onAliasKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }, term: string, aliases: string[]) {
    const input = event.currentTarget;
    if (event.key === "Enter" && !event.isComposing) addAlias(input, term);
    if (event.key === "Backspace" && !input.value && aliases.length) editor.removeAlias(term, aliases[aliases.length - 1]);
    if (event.key === "Escape") { input.value = ""; editor.clearError(); }
  }

  function removeAlias(button: HTMLElement, term: string, alias: string) {
    const input = aliasInputNear(button);
    editor.removeAlias(term, alias);
    input?.focus();
  }
</script>

{#snippet filter()}
  <SearchField bind:value={editor.query} placeholder="Filter terms" class="w-44 flex-none basis-auto" />
{/snippet}

<SettingsSection
  label="Custom dictionary"
  description="Fix how dictation spells a word. Under Heard as, add what it writes instead."
  action={editor.entries.length ? filter : undefined}
>
  <div class="px-4 py-3">
    <div class="flex items-start gap-2">
      <Textarea
        bind:ref={addInput}
        bind:value={addText}
        dictation={false}
        class="min-h-7 bg-white! py-1 text-sm leading-5! placeholder:text-sm! placeholder:leading-5! disabled:bg-white! dark:bg-input/30! dark:disabled:bg-input/30!"
        oninput={() => editor.clearError()}
        onkeydown={onAddKeydown}
        aria-label="Add terms"
        aria-invalid={editor.error?.term === null}
        placeholder="Add a term, or paste a list with one term per line"
        maxlength={80_000}
        spellcheck={false}
      />
      <Button size="sm" variant="outline" onclick={addTerms} disabled={!addText.trim()}>Add</Button>
    </div>
    {#if editor.error?.term === null}
      <p role="alert" class="mt-2 text-xs text-destructive">{editor.error.message}</p>
    {/if}
  </div>

  {#if editor.visible.length}
    <div class="hidden grid-cols-[minmax(0,1fr)_minmax(0,2fr)_1.5rem] gap-x-4 px-4 py-2 text-xs text-muted-foreground @min-[30rem]/pane:grid">
      <span>Term</span>
      <span>Heard as</span>
    </div>
  {/if}

  <!-- Not keyed: a rename must keep the row, and the focus inside it. -->
  {#each editor.visible as entry}
    <div
      data-term-row
      class="grid grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-x-4 gap-y-1 px-4 py-2 @min-[30rem]/pane:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_1.5rem]"
    >
      <input
        class="col-start-1 row-start-1 -ml-1.5 h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium text-foreground outline-none hover:border-border focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-9"
        value={entry.term}
        onchange={(event) => editor.rename(entry.term, event.currentTarget.value)}
        onkeydown={(event) => onTermKeydown(event, entry.term)}
        aria-label="Term {entry.term}"
        spellcheck={false}
      />
      <div class="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 @min-[30rem]/pane:col-span-1 @min-[30rem]/pane:col-start-2 @min-[30rem]/pane:row-start-1">
        {#each entry.aliases as alias}
          <span class="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2 text-[13px] text-foreground">
            <span class="truncate">{alias}</span>
            <button
              type="button"
              class="relative grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground after:absolute after:-inset-1.5 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onclick={(event) => removeAlias(event.currentTarget, entry.term, alias)}
              aria-label="Remove {alias}"
            ><XIcon size={12} /></button>
          </span>
        {/each}
        <input
          data-alias-input
          class="h-7 min-w-24 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground pointer-coarse:h-9"
          oninput={() => editor.clearError()}
          onkeydown={(event) => onAliasKeydown(event, entry.term, entry.aliases)}
          onblur={(event) => addAlias(event.currentTarget, entry.term)}
          aria-label="Add what dictation writes for {entry.term}"
          placeholder={entry.aliases.length ? "Add" : "Add a phrase"}
          spellcheck={false}
        />
      </div>
      <button
        type="button"
        class="relative col-start-2 row-start-1 grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 @min-[30rem]/pane:col-start-3"
        onclick={() => { editor.remove(entry.term); addInput?.focus(); }}
        aria-label="Remove {entry.term}"
      ><XIcon size={14} /></button>
      {#if editor.error?.term === entry.term}
        <p role="alert" class="col-span-full text-xs text-destructive">{editor.error.message}</p>
      {/if}
    </div>
  {:else}
    <p class="px-4 py-3.5 text-[13px] text-(--solus-text-secondary)">
      {editor.entries.length ? "No terms match your filter." : "No terms yet."}
    </p>
  {/each}

  <p class="px-4 py-2.5 text-xs text-muted-foreground">
    {editor.entries.length} of {VOICE_DICTIONARY_LIMIT} terms. Used for desktop and web dictation from your next recording. Follows settings sync.
  </p>
</SettingsSection>
