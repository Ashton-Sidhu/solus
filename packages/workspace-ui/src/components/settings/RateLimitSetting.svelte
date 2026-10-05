<script lang="ts">
  import type { RateLimitBehavior } from "@solus/contracts/settings";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import SettingsRow from "./SettingsRow.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getSettingsContext } from "../../contexts";

  let { visible = true }: { visible?: boolean } = $props();
  const settings = getSettingsContext();
  const rateLimitStrats: [RateLimitBehavior, string][] = [
    ["ask", "Ask"], ["queue", "Queue"], ["stop", "Stop"], ["continue", "Continue"],
  ];
  const rateLimitLabel = $derived(
    rateLimitStrats.find(([value]) => value === settings.rateLimitBehavior)?.[1] ?? settings.rateLimitBehavior,
  );
</script>

<SettingsRow
  label="Rate limit behavior"
  description="What your runs do when they hit a provider rate limit, on every host."
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
            class="min-w-24 justify-between text-xs font-normal shadow-xs"
          >
            <span>{rateLimitLabel}</span>
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
        <DropdownMenu.RadioGroup value={settings.rateLimitBehavior}>
          {#each rateLimitStrats as [val, label] (val)}
            <DropdownMenu.RadioItem
              value={val}
              onSelect={() => settings.setPersonal("rateLimitBehavior", val)}
            >
              {label}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}
</SettingsRow>
