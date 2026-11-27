<script lang="ts">
  import { tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { AppSecretState, AppSummary } from "@solus/contracts/apps";
  import { serversStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { SECRETS_EMPTY } from "./lib/section-empty";
  import { missingSecretNames, secretVaultSummary } from "./lib/app-secrets";

  /**
   * The secrets the active version declares (docs/plans/apps.md §4.4): a head
   * line, a warning when a secret has no value, and one floating table with a
   * row for each secret. An empty row is a field to paste the value in; a row
   * with a value shows only that it has one, and its owner replaces or clears
   * it. A value is never read back. Clear asks first, in its row. A note under
   * the table says what a value is and where it lives.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    secrets: AppSecretState[] | undefined;
  }
  let { serverId, app, secrets }: Props = $props();

  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? serverId);
  const missingNames = $derived(missingSecretNames(secrets ?? []));

  /** What the person pasted in each open field, by secret name. */
  const drafts = new SvelteMap<string, string>();
  /** The slot with a value whose field is open to replace it. */
  let replacingName = $state<string | null>(null);
  /** The slot that asks before it clears its value. */
  let clearingName = $state<string | null>(null);
  let busyName = $state<string | null>(null);

  function openReplace(name: string) {
    clearingName = null;
    drafts.delete(name);
    replacingName = name;
  }

  /** Closes what the row opened and gives the keyboard back to the row's action. */
  async function closeRow(name: string) {
    drafts.delete(name);
    if (replacingName === name) replacingName = null;
    if (clearingName === name) clearingName = null;
    await tick();
    document.querySelector<HTMLElement>(`[data-secret-action="${name}"]`)?.focus();
  }

  function handleFieldKeydown(event: KeyboardEvent, name: string) {
    if (event.key !== "Escape") return;
    // The Manage page must not also take this Escape.
    event.preventDefault();
    event.stopPropagation();
    void closeRow(name);
  }

  async function save(secret: AppSecretState, value: string | null) {
    if (busyName || value === "") return;
    busyName = secret.name;
    try {
      await appsStore.setSecret(serverId, app.id, secret.name, value);
      await closeRow(secret.name);
    } catch (error) {
      toasts.error(value === null ? "The secret was not cleared" : "The secret was not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyName = null;
    }
  }
</script>

<ManageSectionState
  count={secrets?.length}
  error={appsStore.stateErrorFor(serverId, app.id)}
  {serverId}
  {app}
  empty={SECRETS_EMPTY}
  onRetry={() => void appsStore.loadState(serverId, app.id)}
>
  <div class="flex min-w-0 flex-col gap-7 pt-1.5" data-testid="app-secrets">
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 px-0.5 pt-1">
      <h3 id="app-secrets-title" class="m-0 text-[15px] leading-5 font-semibold text-foreground">Secrets</h3>
      <p class="m-0 min-w-0 text-[13px] leading-4.5 text-(--solus-text-tertiary)">{secretVaultSummary(secrets ?? [], hostLabel)}</p>
    </div>

    {#if missingNames.length > 0}
      <div class="min-w-0 text-[13px]" data-testid="app-secrets-missing">
        <MarkdownAlert alertType="warning">
          {#snippet content()}
            <p class="m-0 text-pretty text-foreground">
              {#each missingNames as name, index (name)}{#if index > 0}, {/if}<code class="font-mono text-xs">{name}</code>{/each}
              {missingNames.length === 1 ? "has no value. Calls that read it fail until you add one." : "have no value. Calls that read them fail until you add them."}
            </p>
          {/snippet}
        </MarkdownAlert>
      </div>
    {/if}

    <!-- The one floating table of the section. Rules only between rows. -->
    <section class="flex min-w-0 flex-col rounded-2xl bg-background pt-1 pb-1.5 shadow-[shadow:var(--elev-lift)]" aria-labelledby="app-secrets-title">
      <div class="flex h-9 min-w-0 items-center gap-4 px-4 text-[10px] leading-3 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase @max-[44rem]/pane:hidden" aria-hidden="true">
        <span class="w-65 shrink-0">Name</span>
        <span class="min-w-0 flex-1">Value</span>
        <span class="w-37.5 shrink-0"></span>
      </div>

      {#each secrets ?? [] as secret, index (secret.name)}
        {@const isEmpty = !secret.isSet}
        {@const isReplacing = replacingName === secret.name}
        {@const isClearing = clearingName === secret.name}
        {@const isFieldOpen = isEmpty || isReplacing}
        {@const isBusy = busyName === secret.name}
        {@const draft = drafts.get(secret.name) ?? ""}
        <div
          class="mx-4 flex min-h-15 min-w-0 flex-wrap items-center gap-x-4 gap-y-2.5 py-2.5 {index > 0 ? 'border-t border-border/40' : ''}"
          data-testid="app-secret"
          data-secret={secret.name}
        >
          <div class="flex w-65 min-w-0 shrink-0 flex-col gap-0.5 @max-[44rem]/pane:w-auto @max-[44rem]/pane:flex-1">
            <span class="truncate font-mono text-[12.5px] leading-4.5 text-foreground">{secret.name}</span>
            <span class="truncate text-xs leading-4 text-(--solus-text-tertiary)" title={secret.description || undefined}>{secret.label}</span>
          </div>

          <!-- The value: a field when the row is open, the question of Clear, or dots for a saved value. -->
          <div class="flex min-w-0 flex-1 basis-56 items-center @max-[44rem]/pane:order-last @max-[44rem]/pane:basis-full">
            {#if isFieldOpen}
              <Input
                type="password"
                dictation={false}
                autofocus={isReplacing}
                autocomplete="off"
                spellcheck={false}
                data-1p-ignore
                class="h-8 rounded-md bg-background text-[13px] shadow-[shadow:var(--elev-ring)] focus-visible:shadow-[shadow:0_0_0_3px_color-mix(in_oklch,var(--primary)_10%,transparent)]"
                aria-label="{isReplacing ? 'New value' : 'Value'} of {secret.name}"
                placeholder={isReplacing ? "Paste the new value" : "Paste the value"}
                disabled={isBusy}
                value={draft}
                oninput={(event) => drafts.set(secret.name, event.currentTarget.value)}
                onkeydown={(event) => handleFieldKeydown(event, secret.name)}
                submitOn="enter"
                onSubmit={() => void save(secret, draft)}
                data-testid="app-secret-field"
              />
            {:else if isClearing}
              <p class="m-0 min-w-0 text-[13px] leading-4.5 text-pretty text-foreground" role="alert">Clear this value? Calls that read it fail until you add one.</p>
            {:else}
              <span class="truncate font-mono text-[13px] leading-4.5 tracking-[0.1em] text-(--solus-text-tertiary)" aria-label="A value is saved">••••••••••••</span>
            {/if}
          </div>

          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex shrink-0 items-center justify-end gap-1 {isClearing ? 'w-63.5' : 'w-37.5'} @max-[44rem]/pane:w-auto"
            onkeydown={(event) => isClearing && handleFieldKeydown(event, secret.name)}
          >
            {#if isFieldOpen}
              {#if isReplacing || draft !== ""}
                <Button size="sm" variant="ghost" class="h-7.5 rounded-md text-[13px] font-normal text-(--solus-text-secondary)" disabled={isBusy} onclick={() => void closeRow(secret.name)}>Cancel</Button>
              {/if}
              <Button size="sm" class="h-7.5 rounded-md px-3 text-[13px]" disabled={isBusy || draft === ""} onclick={() => void save(secret, draft)} data-testid="app-secret-save">
                {isBusy ? "Saving…" : "Save"}
              </Button>
            {:else if isClearing}
              <!-- svelte-ignore a11y_autofocus -->
              <Button size="sm" variant="ghost" class="h-7.5 rounded-md text-[13px] font-normal text-(--solus-text-secondary)" autofocus disabled={isBusy} onclick={() => void closeRow(secret.name)}>Cancel</Button>
              <Button
                size="sm"
                class="h-7.5 rounded-md bg-destructive px-3 text-[13px] text-white hover:bg-destructive/90"
                disabled={isBusy}
                onclick={() => void save(secret, null)}
                data-testid="app-secret-clear-confirm"
              >
                {isBusy ? "Clearing…" : "Clear value"}
              </Button>
            {:else}
              <Button
                size="sm"
                variant="ghost"
                class="h-7.5 rounded-md text-[13px] font-normal text-(--solus-text-secondary)"
                disabled={busyName !== null}
                onclick={() => {
                  replacingName = null;
                  clearingName = secret.name;
                }}
                data-testid="app-secret-clear">Clear</Button
              >
              <Button
                size="sm"
                variant="ghost"
                class="h-7.5 rounded-md px-3 text-[13px] font-normal text-foreground shadow-[shadow:var(--elev-ring)]"
                data-secret-action={secret.name}
                disabled={busyName !== null}
                onclick={() => openReplace(secret.name)}
              >
                Replace
              </Button>
            {/if}
          </div>
          {#if isReplacing}
            <p class="m-0 basis-full pl-69 text-xs text-(--solus-text-tertiary) @max-[44rem]/pane:order-last @max-[44rem]/pane:pl-0">The new value replaces the saved one. Enter saves, Esc cancels.</p>
          {/if}
        </div>
      {/each}
    </section>

    <!-- What a value is, who reads it, and where it is declared. -->
    <div class="mt-2 min-w-0 text-[13px]">
      <MarkdownAlert alertType="note">
        {#snippet content()}
          <div class="flex min-w-0 flex-col gap-1.5 text-pretty text-(--solus-text-secondary)">
            <p class="m-0">Values are write-only. After you save one, no one can read it back: not you, the app’s UI, or an agent. You can only replace or clear it.</p>
            <p class="m-0">The app’s backend reads a value on each call. A new value applies from the next call. Values are in the secret store on {hostLabel}, not in the app’s data, its files, or the call log.</p>
            <p class="m-0">The app declares its secrets in <code class="font-mono text-xs text-foreground">app.ts</code>. To add or rename one, change the code and deploy.</p>
          </div>
        {/snippet}
      </MarkdownAlert>
    </div>
  </div>
</ManageSectionState>
