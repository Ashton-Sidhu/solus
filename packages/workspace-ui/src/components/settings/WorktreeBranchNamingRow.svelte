<script lang="ts">
  /** One branch naming: the mode, its prefix or template, and an example of
   *  the name it makes. Used for the host setting and a project's override. */
  import { tick } from "svelte";
  import {
    worktreeBranchNamingError,
    worktreeBranchPreview,
    type WorktreeBranchNaming,
    type WorktreeBranchNamingMode,
  } from "@solus/contracts/worktree-branch-naming";
  import { Input } from "../ui/input";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";

  interface Props {
    label: string;
    naming: WorktreeBranchNaming;
    disabled?: boolean;
    onSave: (naming: WorktreeBranchNaming) => void;
  }

  let { label, naming, disabled = false, onSave }: Props = $props();

  const modes: ReadonlyArray<{ value: WorktreeBranchNamingMode; label: string; description: string }> = [
    { value: "generated", label: "Name from title", description: "Starts on a short id, then takes a name made from the first prompt." },
    { value: "static", label: "Short id", description: "Keeps a short random id. No model names the branch." },
    { value: "custom", label: "Custom template", description: "Tokens: {prefix}, {slug}, {id}, {user}. {slug} is the name from the title." },
  ];

  let inputElement = $state<HTMLInputElement | null>(null);
  let draft = $state("");
  let draftSource = $state<string | null>(null);
  const field = $derived(naming.mode === "custom" ? "template" : "prefix");
  const saved = $derived(naming[field]);
  const draftNaming = $derived<WorktreeBranchNaming>(
    field === "template" ? { ...naming, template: draft } : { ...naming, prefix: draft },
  );
  const error = $derived(worktreeBranchNamingError(draftNaming));
  const preview = $derived(worktreeBranchPreview(draftNaming));

  // Follow the saved value, unless the user is typing over it.
  $effect(() => {
    const value = saved;
    if (value === draftSource) return;
    draft = value;
    draftSource = value;
  });

  async function selectMode(mode: WorktreeBranchNamingMode): Promise<void> {
    if (mode === naming.mode) return;
    onSave({ ...naming, mode });
    await tick();
    inputElement?.focus({ preventScroll: true });
  }

  function save(): void {
    if (error || draft === saved) return;
    onSave(draftNaming);
  }
</script>

<SettingsRow {label} description={modes.find((mode) => mode.value === naming.mode)?.description}>
  {#snippet control()}
    <SettingsSelect
      options={modes}
      value={naming.mode}
      onSelect={(mode) => void selectMode(mode)}
      ariaLabel="{label} mode"
      {disabled}
    />
  {/snippet}
  {#snippet body()}
    <div class="flex flex-col gap-2">
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        {field === "template" ? "Template" : "Prefix"}
        <Input
          bind:ref={inputElement}
          bind:value={draft}
          {disabled}
          maxlength={field === "template" ? 200 : 100}
          placeholder={field === "template" ? "{prefix}/{user}/{slug}" : "solus"}
          spellcheck={false}
          autocomplete="off"
          aria-invalid={error ? true : undefined}
          class="font-mono text-sm"
          onblur={save}
          onkeydown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") draft = saved;
          }}
        />
      </label>
      {#if error}
        <p class="text-xs text-destructive" role="alert">{error} Solus uses solus/&lbrace;slug&rbrace; until you fix it.</p>
      {/if}
      <p class="text-xs text-muted-foreground">
        Example: <code class="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{preview}</code>
      </p>
    </div>
  {/snippet}
</SettingsRow>
