<script lang="ts">
  /**
   * The Solus Cloud address of this device (docs/solus-cloud-address.md): the
   * control plane that the app signs in to. A field while signed out; the
   * address as text, with the reason, while a sign-in is held or the
   * environment sets it. The app keeps the choice for this device and checks
   * it; no host receives it. Absent on the web, where the control plane
   * serves the client.
   */
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { DEFAULT_CLOUD_ORIGIN, cloudAddressChangeRefusalText } from "@solus/contracts/cloud-address";
  import { accountStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsRow from "./SettingsRow.svelte";
  import { cloudAddressRow } from "./lib/cloud-address-row";

  const address = $derived(accountStore.cloudAddress);
  const row = $derived(address ? cloudAddressRow(accountStore.state, address) : null);
  /** What the person typed; null shows the address in effect. */
  let draft = $state<string | null>(null);
  let changeError = $state<string | null>(null);
  let isSaving = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  const shownAddress = $derived(draft ?? address?.origin ?? "");
  const error = $derived(changeError ?? row?.signInError ?? null);

  async function change(next: string | null) {
    isSaving = true;
    try {
      const ended = await accountStore.setCloudAddress(next);
      if (ended?.ok) draft = null;
      changeError = ended && !ended.ok ? cloudAddressChangeRefusalText(ended.refusal) : null;
    } finally {
      isSaving = false;
    }
    // Save turns inert after a change; the field keeps the keyboard.
    input?.focus();
  }
</script>

{#if address && row}
  <SettingsRow
    {...settingsDefinitions["account.cloud-address"]}
    description={row.lockNote ?? settingsDefinitions["account.cloud-address"].description}
    bodyVisible={row.isEditable || error !== null}
    testId="cloud-address-row"
  >
    {#snippet control()}
      {#if !row.isEditable}
        <span class="min-w-0 truncate text-[13px] leading-[1.45] text-(--solus-text-secondary) select-text">{address.origin}</span>
      {/if}
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-2">
        {#if row.isEditable}
          <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); void change(shownAddress); }}>
            <Input
              bind:ref={input}
              value={shownAddress}
              oninput={(event) => { draft = event.currentTarget.value; changeError = null; }}
              id="cloud-address"
              type="text"
              inputmode="url"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              dictation={false}
              maxlength={2048}
              aria-label="Solus Cloud address"
              aria-invalid={changeError !== null}
              aria-describedby={error ? "cloud-address-error" : undefined}
              placeholder={DEFAULT_CLOUD_ORIGIN}
              disabled={isSaving}
              class="min-w-48 flex-1 text-workspace-chrome"
            />
            <Button type="submit" class="pointer-coarse:min-h-11" disabled={isSaving || !shownAddress.trim() || shownAddress.trim() === address.origin}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
            {#if address.source === "setting"}
              <Button type="button" variant="outline" class="pointer-coarse:min-h-11" disabled={isSaving} onclick={() => void change(null)}>Use {DEFAULT_CLOUD_ORIGIN.replace("https://", "")}</Button>
            {/if}
          </form>
        {/if}
        {#if error}
          <p id="cloud-address-error" role="alert" class="text-pretty text-xs text-destructive">{error}</p>
        {/if}
      </div>
    {/snippet}
  </SettingsRow>
{/if}
