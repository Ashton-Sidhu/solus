<script lang="ts">
  /** The Outside apps limit of a policy (`sessions.limits.apps`, plans/035 §10):
   *  every app, or the apps a person chooses. It edits the document's text, so
   *  the text field, its check, and its changes stay the one source. */
  import { OUTSIDE_APP_IDS, OUTSIDE_APP_NAMES, type OutsideAppId } from "@solus/contracts/outside-apps";
  import type { PolicyDocument } from "@solus/contracts/policy";
  import { Checkbox } from "../../ui/checkbox";
  import SettingsSelect from "../SettingsSelect.svelte";
  import { allowedOutsideApps, toggledOutsideApp, withAllowedOutsideApps } from "./lib/policy-outside-apps";

  interface Props {
    /** The document as it passes the check; null while the text does not. */
    document: PolicyDocument | null;
    readOnly: boolean;
    onChange: (document: PolicyDocument) => void;
  }

  let { document, readOnly, onChange }: Props = $props();

  const idPrefix = $props.id();
  const allowed = $derived(document ? allowedOutsideApps(document) : null);
  const isInert = $derived(readOnly || !document);

  const SCOPES: ReadonlyArray<{ value: "all" | "chosen"; label: string }> = [
    { value: "all", label: "All apps" },
    { value: "chosen", label: "Only these apps" },
  ];

  function chooseScope(scope: "all" | "chosen") {
    if (!document || (scope === "chosen") === !!allowed) return;
    onChange(withAllowedOutsideApps(document, scope === "chosen" ? OUTSIDE_APP_IDS : null));
  }

  function toggle(app: OutsideAppId, on: boolean) {
    if (document && allowed) onChange(withAllowedOutsideApps(document, toggledOutsideApp(allowed, app, on)));
  }
</script>

<fieldset class="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="policy-outside-apps">
  <legend class="sr-only">Outside apps</legend>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-workspace-chrome font-medium text-foreground" aria-hidden="true">Outside apps</span>
      <span class="text-xs text-muted-foreground">
        {#if !document}
          Fix the issues in this document to choose apps here.
        {:else}
          The apps that people may connect to Solus over MCP (<code class="font-mono">sessions.limits.apps</code>).
        {/if}
      </span>
    </div>
    <SettingsSelect options={SCOPES} value={allowed ? "chosen" : "all"} onSelect={chooseScope} ariaLabel="Outside apps" disabled={isInert} compact />
  </div>
  {#if allowed}
    <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 @min-[30rem]/pane:grid-cols-2">
      {#each OUTSIDE_APP_IDS as app (app)}
        {@const isOn = allowed.includes(app)}
        <label for="{idPrefix}-{app}" class="flex items-center gap-2.5 text-xs text-foreground pointer-coarse:min-h-11">
          <Checkbox
            id="{idPrefix}-{app}"
            checked={isOn}
            disabled={isInert || (isOn && allowed.length === 1)}
            onCheckedChange={(on) => toggle(app, on)}
          />
          {OUTSIDE_APP_NAMES[app]}
        </label>
      {/each}
    </div>
  {/if}
</fieldset>
