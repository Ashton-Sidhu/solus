<script lang="ts">
  /**
   * The fields of a command (docs/plans/mcp-first-class.md §7.7): the line with
   * the program and arguments it gives, the working directory, the environment
   * variable names, and, when it adds, the name and the values. The add dialog
   * and the row's editor share it; the caller owns the form and its buttons.
   */
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
</script>

{#snippet hint(id: string, text: string | null, isError: boolean)}
  {#if text}
    <p {id} role={isError ? "alert" : undefined} class="break-words text-chrome-dense {isError ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">{text}</p>
  {/if}
{/snippet}

<div class="flex flex-col gap-3.5">
  {#if !form.editing}
    <div class="flex flex-col gap-1.5">
      <label for="{idPrefix}-name" class="text-workspace-chrome font-medium text-foreground">Name</label>
      <Input id="{idPrefix}-name" bind:value={form.name} placeholder={form.preview ? suggestedCommandName(form.preview) : "Filesystem"} autocomplete="off" spellcheck={false} {disabled}
        class="h-8 min-w-0 text-workspace-chrome" />
    </div>
  {/if}

  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-line" class="text-workspace-chrome font-medium text-foreground">Command</label>
    <!-- svelte-ignore a11y_autofocus -->
    <Input id="{idPrefix}-line" bind:value={form.line} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes" autocomplete="off" spellcheck={false} dictation={false} {disabled}
      autofocus aria-invalid={lineProblem ? true : undefined} aria-describedby="{idPrefix}-line-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
    {#if lineProblem}
      {@render hint(`${idPrefix}-line-hint`, lineProblem, true)}
    {:else if form.preview}
      <!-- What the host starts, word by word: no shell reads it (§7.4). -->
      <p id="{idPrefix}-line-hint" class="flex min-w-0 flex-wrap items-center gap-1 text-chrome-dense text-(--solus-text-secondary)">
        Starts <span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">{form.preview.command}</span>
        {#each form.preview.args as arg, index (index)}
          <span class="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono">{arg || " "}</span>
        {/each}
      </p>
    {:else}
      {@render hint(`${idPrefix}-line-hint`, "One program and its arguments. Solus starts it without a shell.", false)}
    {/if}
  </div>

  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-cwd" class="text-workspace-chrome font-medium text-foreground">Working directory</label>
    <Input id="{idPrefix}-cwd" bind:value={form.cwd} placeholder="~" autocomplete="off" spellcheck={false} dictation={false} {disabled}
      aria-describedby="{idPrefix}-cwd-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
    {@render hint(`${idPrefix}-cwd-hint`, form.problemOf("cwd") ?? "Optional. A folder on the host; ~ is the home folder.", !!form.problemOf("cwd"))}
  </div>

  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-env" class="text-workspace-chrome font-medium text-foreground">Environment variables</label>
    <Input id="{idPrefix}-env" bind:value={form.envNames} placeholder="GITHUB_TOKEN, API_URL" autocomplete="off" spellcheck={false} dictation={false} {disabled}
      aria-invalid={form.problemOf("envNames") ? true : undefined} aria-describedby="{idPrefix}-env-hint" class="h-8 min-w-0 font-mono text-workspace-chrome" />
    {@render hint(`${idPrefix}-env-hint`, form.problemOf("envNames") ?? "Names only, separated by commas. Each value is a secret, saved for you alone and never shown again.", !!form.problemOf("envNames"))}
  </div>

  {#if showValues && form.names.length > 0}
    <McpCommandValues names={form.names} values={form.values} hasSaved={hasSavedValues} idPrefix="{idPrefix}-value" {disabled} />
  {/if}

  {@render hint(`${idPrefix}-form-error`, form.problemOf("form"), true)}
</div>
