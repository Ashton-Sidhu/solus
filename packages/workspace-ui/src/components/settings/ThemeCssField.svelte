<script lang="ts">
  import { onDestroy } from "svelte";
  import { THEME_CSS_MAX_LENGTH, themeCssLoadsFiles } from "@solus/contracts/theme-css";
  import { getSettingsContext } from "../../contexts";
  import { applyThemeCss } from "../../contexts/app/theme-css";
  import { Button } from "../ui/button";
  import { Textarea } from "../ui/textarea";

  const settings = getSettingsContext();

  let editor: HTMLTextAreaElement | null = $state(null);
  let draft = $state(settings.themeCss);
  const loadsFiles = $derived(themeCssLoadsFiles(draft));
  const isChanged = $derived(draft !== settings.themeCss);

  // The draft paints as it is typed; leaving Settings paints the saved CSS again.
  onDestroy(() => applyThemeCss(settings.themeCss));

  function preview() {
    if (!loadsFiles) applyThemeCss(draft);
  }

  function save() {
    if (loadsFiles || !isChanged) return;
    settings.setPersonal("themeCss", draft);
    editor?.focus();
  }

  function clear() {
    draft = "";
    settings.setPersonal("themeCss", "");
    applyThemeCss("");
    editor?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
    if (event.key === "Escape" && isChanged) {
      event.preventDefault();
      draft = settings.themeCss;
      applyThemeCss(draft);
    }
  }
</script>

<div class="space-y-2">
  <Textarea
    bind:ref={editor}
    bind:value={draft}
    dictation={false}
    rows={8}
    maxlength={THEME_CSS_MAX_LENGTH}
    spellcheck={false}
    placeholder={'.dark {\n  --solus-accent: #7aa2f7;\n}\n[data-slot="user-message"] {\n  border-radius: 4px;\n}'}
    aria-label="Custom CSS"
    aria-invalid={loadsFiles}
    class="font-mono text-xs bg-white! disabled:bg-white! dark:bg-input/30! dark:disabled:bg-input/30!"
    oninput={preview}
    onkeydown={onKeydown}
  />
  {#if loadsFiles}
    <p role="alert" class="text-xs text-destructive">
      Theme CSS cannot load files: no @import, no image-set(), and url() only with data: or #id.
    </p>
  {/if}
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="min-w-52 flex-1 text-pretty text-xs text-muted-foreground">
      The preview shows as you type. Save with ⌘↩, or press Esc to go back to the saved CSS.
    </p>
    <div class="flex items-center gap-2">
      {#if settings.themeCss}
        <Button size="sm" variant="ghost" onclick={clear}>Clear</Button>
      {/if}
      <Button size="sm" disabled={loadsFiles || !isChanged} onclick={save}>Save CSS</Button>
    </div>
  </div>
</div>
