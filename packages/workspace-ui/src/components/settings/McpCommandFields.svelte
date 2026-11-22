<script lang="ts">
  /**
   * The fields of a command (docs/plans/mcp-first-class.md §7.7): the line with
   * the program and arguments it gives, and, when it adds, the name the line
   * suggests. The working directory, the environment variable names, and the
   * values are optional: they fold under "Folder and variables", which opens by
   * itself when one is filled or refused. The add dialog and the row's editor
   * share it; the caller owns the form and its buttons.
   */
  import { untrack } from "svelte";
  import { ChevronRight } from "@lucide/svelte";
  import { suggestedCommandName } from "@solus/contracts/integrations/command-server";
  import { Input } from "../ui/input";
  import McpCommandValues from "./McpCommandValues.svelte";
  import type { McpCommandForm } from "./lib/mcp-command.svelte";

  interface Props {
    form: McpCommandForm;
    idPrefix: string;
    /** Show a field for each value: the add dialog takes them with the command. */
    showValues?: boolean;
    hasSavedValues?: boolean;
    disabled?: boolean;
  }

  let { form, idPrefix, showValues = false, hasSavedValues = false, disabled = false }: Props = $props();

  const lineProblem = $derived(form.problemOf("line") ?? form.lineProblem);
  const optionalProblem = $derived(form.problemOf("cwd") ?? form.problemOf("envNames"));
  /** The person opened the optional fields, or the command they edit has some. */
  let isMoreOpen = $state(untrack(() => !!form.cwd.trim() || !!form.envNames.trim()));
  const showsMore = $derived(isMoreOpen || !!optionalProblem);
  const moreSummary = $derived([form.cwd.trim(), form.names.length > 0 ? `${form.names.length} ${form.names.length === 1 ? "variable" : "variables"}` : ""].filter(Boolean).join(" · "));
</script>

{#snippet hint(id: string, text: string | null, isError: boolean)}
  {#if text}
    <p {id} role={isError ? "alert" : undefined} class="break-words text-chrome-dense {isError ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">{text}</p>
  {/if}
{/snippet}

<div class="flex flex-col gap-3.5">
  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-line" class="text-workspace-chrome font-medium text-foreground">Command</label>
    <!-- svelte-ignore a11y_autofocus -->
    <Input id="{idPrefix}-line" bind:value={form.line} placeholder="npx -y @modelcontextprotocol/server-memory" autocomplete="off" spellcheck={false} dictation={false} {disabled}
      autofocus aria-invalid={lineProblem ? true : undefined} aria-describedby="{idPrefix}-line-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
    {#if lineProblem}
      {@render hint(`${idPrefix}-line-hint`, lineProblem, true)}
    {:else if form.preview}
      <!-- What the host starts, word by word: no shell reads it (§7.4). -->
      <p id="{idPrefix}-line-hint" class="flex min-w-0 flex-wrap items-center gap-1 text-chrome-dense text-(--solus-text-secondary)">
        Starts <span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">{form.preview.command}</span>
        {#each form.preview.args as arg, index (index)}
          <span class="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono">{arg || " "}</span>
        {/each}
      </p>
    {:else}
      {@render hint(`${idPrefix}-line-hint`, "A program and its arguments, such as npx or uvx. Solus starts it without a shell.", false)}
    {/if}
  </div>

  {#if !form.editing}
    <div class="flex flex-col gap-1.5">
      <label for="{idPrefix}-name" class="text-workspace-chrome font-medium text-foreground">Name</label>
      <Input id="{idPrefix}-name" bind:value={form.name} placeholder={form.preview ? suggestedCommandName(form.preview) : "Memory"} autocomplete="off" spellcheck={false} {disabled}
        class="h-8 min-w-0 text-workspace-chrome" />
    </div>
  {/if}

  <div class="flex flex-col gap-3">
    <button type="button" class="-ml-1 flex min-h-7 w-fit min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1 text-workspace-chrome text-(--solus-text-secondary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      aria-expanded={showsMore} aria-controls="{idPrefix}-more" onclick={() => (isMoreOpen = !showsMore)}>
      <ChevronRight size={14} class="shrink-0 transition-transform motion-reduce:transition-none {showsMore ? 'rotate-90' : ''}" />
      <span class="shrink-0">Folder and variables</span>
      {#if !showsMore && moreSummary}<span class="truncate font-mono text-chrome-dense text-muted-foreground">{moreSummary}</span>{/if}
    </button>

    <!-- Hidden, not unmounted: the typed values stay while the section is closed. -->
    <div id="{idPrefix}-more" class="flex flex-col gap-3.5 border-l border-border pl-3.5 {showsMore ? '' : 'hidden'}">
      <div class="flex flex-col gap-1.5">
        <label for="{idPrefix}-cwd" class="text-workspace-chrome font-medium text-foreground">Working directory</label>
        <Input id="{idPrefix}-cwd" bind:value={form.cwd} placeholder="~" autocomplete="off" spellcheck={false} dictation={false} {disabled}
          aria-describedby="{idPrefix}-cwd-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
        {@render hint(`${idPrefix}-cwd-hint`, form.problemOf("cwd") ?? "A folder on the host. Empty is the home folder.", !!form.problemOf("cwd"))}
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="{idPrefix}-env" class="text-workspace-chrome font-medium text-foreground">Environment variables</label>
        <Input id="{idPrefix}-env" bind:value={form.envNames} placeholder="GITHUB_TOKEN, API_URL" autocomplete="off" spellcheck={false} dictation={false} {disabled}
          aria-invalid={form.problemOf("envNames") ? true : undefined} aria-describedby="{idPrefix}-env-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
        {@render hint(`${idPrefix}-env-hint`, form.problemOf("envNames") ?? "Names, separated by commas. Each value is a secret that only you can use.", !!form.problemOf("envNames"))}
      </div>

      {#if showValues && form.names.length > 0}
        <McpCommandValues names={form.names} values={form.values} hasSaved={hasSavedValues} idPrefix="{idPrefix}-value" {disabled} />
      {/if}
    </div>
  </div>

  {@render hint(`${idPrefix}-form-error`, form.problemOf("form"), true)}
</div>
