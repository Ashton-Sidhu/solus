<script lang="ts">
  import type { AppOperation } from "@solus/contracts/apps";
  import { operationFields, operationInputTemplate, operationKindLabel, operationSchemaNode, operationTimeLimitText, type OperationField } from "@solus/client-core/app-operations";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { isMac } from "../../../lib/keybindings/match";
  import { formatDuration } from "../../insights/lib/format";
  import CodeEditor from "../../code-editor/CodeEditor.svelte";
  import { jsonSchemaCompletionSource, jsonSchemaProblems } from "../../code-editor/lib/json-schema";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { hasSchema, jsonText, operationInput, runOperation, spanSummary } from "./lib/operations";

  /**
   * The request console of the Operations section (docs/plans/apps.md §9.2):
   * one floating card that runs one operation as the app's UI does. The
   * request column has the JSON input in the code editor, which starts from
   * the operation's fields, completes them from its input schema, and marks
   * a field or a value the schema does not take; then what it takes, and its
   * facts as plain text. The response column, in the same card, has the
   * state, the time, the value, and what the call waited for. Space, not
   * rules, separates the groups. ⌘↵ runs it.
   */
  interface Props {
    serverId: string;
    appId: string;
    operation: AppOperation;
    /** Why the operation cannot run now; null when it can. */
    refusal: string | null;
    /** Opens the calls of this operation in Activity; absent where no section can open. */
    onOpenActivity?: () => void;
  }
  let { serverId, appId, operation, refusal, onOpenActivity }: Props = $props();

  type Response = ({ ok: true; value: string } | { ok: false; error: string }) & { durationMs: number | null; summary: string | null };

  const inputFields = $derived(operationFields(operation.input));
  const outputFields = $derived(operation.output ? operationFields(operation.output) : []);
  const takesInput = $derived(inputFields === null || inputFields.length > 0);
  // The form starts from the fields of the schema it opened with; another operation re-mounts the console.
  // svelte-ignore state_referenced_locally
  let inputText = $state(operationFields(operation.input)?.length === 0 ? "" : operationInputTemplate(operation.input));
  let isRunning = $state(false);
  let response = $state<Response | null>(null);
  let showsSchemas = $state(false);
  const runKey = isMac ? "⌘↵" : "Ctrl↵";
  const inputSchema = $derived(operationSchemaNode(operation.input));
  const inputProblems = $derived(jsonSchemaProblems(inputText, inputSchema));
  const completeInput = jsonSchemaCompletionSource(() => inputSchema);

  async function run() {
    if (isRunning || refusal !== null) return;
    const input = operationInput(takesInput ? inputText : "");
    if (!input.ok) {
      response = { ok: false, error: input.error, durationMs: null, summary: null };
      return;
    }
    isRunning = true;
    const hostId = serverId;
    const id = appId;
    const name = operation.name;
    const startedAt = Date.now();
    let outcome: Response;
    try {
      const value = await runOperation((callName, argumentsJson) => appsStore.call(hostId, id, callName, argumentsJson), name, input.value);
      outcome = { ok: true, value: jsonText(value), durationMs: Date.now() - startedAt, summary: null };
    } catch (cause) {
      outcome = { ok: false, error: cause instanceof Error ? cause.message : "The call failed.", durationMs: Date.now() - startedAt, summary: null };
    }
    // The call log has the run: its own time, and what it waited for. A host that cannot say keeps the time of the round trip.
    try {
      const call = await appsStore.latestUiCall(hostId, id, name, startedAt - 1000);
      if (call) outcome = { ...outcome, durationMs: call.durationMs ?? outcome.durationMs, summary: spanSummary(call.spans) };
    } catch {
      // The value is the answer; the line under it is extra.
    }
    response = outcome;
    isRunning = false;
  }
</script>

{#snippet fieldList(label: string, list: OperationField[] | null, none: string)}
  <div class="flex min-w-0 flex-col gap-2">
    <h4 class="m-0 text-xs font-normal text-(--solus-text-tertiary)">{label}</h4>
    {#if list === null}
      <p class="m-0 text-[13px] text-(--solus-text-secondary)">A shape the JSON schema describes.</p>
    {:else if list.length === 0}
      <p class="m-0 text-[13px] text-(--solus-text-secondary)">{none}</p>
    {:else}
      <dl class="m-0 flex min-w-0 flex-col gap-1.5">
        {#each list as field (field.name)}
          <div class="flex min-w-0 items-baseline gap-3">
            <dt class="w-34 shrink-0 truncate font-mono text-xs text-foreground" title={field.name}>{field.name}</dt>
            <dd class="m-0 min-w-0 flex-1 truncate text-[13px] text-(--solus-text-tertiary)" title={field.description}>{field.description ?? ""}</dd>
            <dd class="m-0 shrink-0 text-xs text-(--solus-text-tertiary)">{field.type}{field.required ? " · required" : ""}</dd>
          </div>
        {/each}
      </dl>
    {/if}
  </div>
{/snippet}

<section
  class="grid min-w-0 grid-cols-1 gap-7 rounded-2xl bg-background px-5.5 pt-5 pb-5.5 shadow-[shadow:var(--elev-lift)] @min-[60rem]/pane:grid-cols-[minmax(0,1fr)_15rem]"
  aria-label="Run {operation.name}"
  data-testid="app-operation-runner"
>
  <div class="flex min-w-0 flex-col gap-5">
    <header class="flex min-w-0 items-start gap-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.75">
        <h3 class="m-0 truncate text-[15px] leading-5 font-semibold text-foreground">{operation.name}</h3>
        <p class="m-0 truncate text-[13px] text-(--solus-text-tertiary)" title={operation.description}>
          {operationKindLabel(operation.kind)}{#if operation.description} · {operation.description}{/if}
        </p>
      </div>
      <Button class="h-7.5 gap-2 pr-2.5 pl-3 text-[13px]" disabled={isRunning || refusal !== null} title={refusal ?? `Run ${operation.name} (${runKey})`} onclick={() => void run()}>
        {isRunning ? "Running…" : "Run"}
        <span class="font-mono text-[11px] opacity-80" aria-hidden="true">{runKey}</span>
      </Button>
    </header>

    {#if takesInput}
      <div class="rounded-[10px] bg-[var(--wash-2)] py-3 pr-3">
        <CodeEditor
          value={inputText}
          onChange={(text) => (inputText = text)}
          size="console"
          ariaLabel="Input of {operation.name}, as JSON"
          placeholder={"{}"}
          complete={completeInput}
          extensionsKey={inputSchema}
          problems={inputProblems}
          onRun={() => void run()}
          class="max-h-80 min-h-34 overflow-auto"
          testId="app-operation-input"
        />
      </div>
    {:else}
      <p class="m-0 text-[13px] text-(--solus-text-secondary)">No input. Run calls it with one press.</p>
    {/if}

    {#if takesInput}
      {@render fieldList("Takes", inputFields, "No input")}
    {/if}
    {#if outputFields === null || outputFields.length > 0}
      {@render fieldList("Answers", outputFields, "An empty object")}
    {/if}

    <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-(--solus-text-tertiary)">
      <span class="tabular-nums">Time limit {operationTimeLimitText(operation.timeoutSeconds)}</span>
      <span title={refusal ?? (operation.kind === "mutation" ? "Run changes the app's data, as a call from its UI does." : undefined)}>
        {refusal ?? (operation.kind === "mutation" ? "Writes app data" : "Only reads")}
      </span>
      {#if hasSchema(operation.input) || hasSchema(operation.output)}
        <Button size="xs" variant="ghost" class="-mr-2 ml-auto text-xs font-normal text-(--solus-text-secondary)" aria-expanded={showsSchemas} onclick={() => (showsSchemas = !showsSchemas)}>
          {showsSchemas ? "Hide the JSON schemas" : "JSON schemas"}
        </Button>
      {/if}
    </div>
    {#if showsSchemas}
      {#each [["Input", operation.input], ["Output", operation.output]] as const as [label, schema] (label)}
        {#if hasSchema(schema)}
          <div class="flex min-w-0 flex-col gap-1">
            <span class="text-xs text-(--solus-text-tertiary)">{label}</span>
            <pre class="m-0 max-h-56 overflow-auto rounded-[10px] bg-[var(--wash-2)] p-3 font-mono text-xs whitespace-pre">{jsonText(schema)}</pre>
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="flex min-w-0 flex-col gap-3 @min-[60rem]/pane:pt-0.5" aria-live="polite">
    <div class="flex min-w-0 items-center gap-2">
      <h4 class="m-0 min-w-0 flex-1 text-[13px] font-medium text-foreground">Response</h4>
      {#if isRunning}
        <StateIcon state="running" size={12} />
        <span class="shrink-0 text-xs text-(--solus-text-tertiary)" role="status" aria-busy="true">Running…</span>
      {:else if response}
        <StateIcon state={response.ok ? "ok" : "failed"} size={12} />
        <span class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)" data-testid="app-operation-status">
          {response.ok ? "OK" : "Failed"}{#if response.durationMs !== null} · {formatDuration(response.durationMs)}{/if}
        </span>
      {/if}
    </div>
    {#if response?.ok && !isRunning}
      <pre class="m-0 max-h-80 overflow-auto rounded-[10px] bg-[var(--wash-2)] p-3 font-mono text-xs leading-5 whitespace-pre text-(--solus-text-secondary) select-text" aria-label="Value" data-testid="app-operation-value">{response.value}</pre>
    {:else if response && !isRunning}
      <div class="min-w-0 text-[13px] select-text" role="alert">
        <MarkdownAlert alertType="error">
          {#snippet content()}<p class="m-0 text-pretty text-foreground">{response?.ok === false ? response.error : ""}</p>{/snippet}
        </MarkdownAlert>
      </div>
    {:else if !isRunning}
      <p class="m-0 text-[13px] text-(--solus-text-tertiary)">Run the operation to see what it answers.</p>
    {/if}
    {#if response?.summary && !isRunning}
      <p class="m-0 text-xs text-pretty text-(--solus-text-tertiary)">{response.summary}</p>
    {/if}
    {#if onOpenActivity}
      <Button size="xs" variant="link" class="h-auto self-start px-0 text-[13px] font-normal text-foreground underline decoration-foreground/25 underline-offset-[3px]" onclick={onOpenActivity}>Open in Activity</Button>
    {/if}
  </div>
</section>
