<script lang="ts">
  import { untrack } from "svelte";
  import type { RateLimitBehavior } from "@solus/contracts/host-config";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import SettingsRow from "./SettingsRow.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { rateLimitSettingsStore as store } from "./rate-limit-settings.store.svelte";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();
  const state = $derived(store.states.get(serverId));
  const rateLimitStrats: [RateLimitBehavior, string][] = [
    ["ask", "Ask"], ["queue", "Queue"], ["stop", "Stop"], ["continue", "Continue"],
  ];
  const rateLimitLabel = $derived(
    rateLimitStrats.find(([value]) => value === state?.behavior)?.[1] ?? "Loading…",
  );
  $effect(() => {
    const hostId = serverId;
    return untrack(() => store.watch(hostId));
  });
</script>

<SettingsRow
  label="Rate limit behavior"
  description="What a run does when it hits a provider rate limit. Applies to all clients."
  {visible}
>
  {#snippet control()}
    <DropdownMenu.Root
      onOpenChange={(next) => {
        if (!next) requestInputFocus();
      }}
    >
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            size="sm"
            aria-label="Rate limit behavior"
            disabled={!state?.behavior || state.saving || !!state.error}
            class="min-w-24 justify-between text-xs font-normal shadow-xs"
          >
            <span>{state?.saving ? "Saving…" : rateLimitLabel}</span>
            <CaretDownIcon size={11} style="opacity:0.6" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={6}
        class="w-[144px]"
      >
        <DropdownMenu.RadioGroup value={state?.behavior ?? undefined}>
          {#each rateLimitStrats as [val, label] (val)}
            <DropdownMenu.RadioItem
              value={val}
              onSelect={() => void store.save(serverId, val)}
            >
              {label}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}
  {#snippet body()}
    {#if state?.error}
      <div class="flex items-center gap-2 text-workspace-chrome" role="status">
        <span class="text-destructive">{state.error}</span>
        <button type="button" class="underline" onclick={() => store.load(serverId)}>Retry</button>
      </div>
    {/if}
  {/snippet}
</SettingsRow>
