<script lang="ts">
  import { taskSettings as settingItems } from "./lib/settings-search-data";
  import type { AgentTaskLifecyclePolicy } from "@solus/contracts/types";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();

  // ─── Task behavior ───

  const taskLifecyclePolicies: Array<{
    value: AgentTaskLifecyclePolicy;
    label: string;
  }> = [
    { value: "none", label: "None" },
    { value: "moderate", label: "Moderate" },
    { value: "autonomous", label: "Autonomous" },
  ];

  const taskLifecyclePolicyLabel = $derived(
    taskLifecyclePolicies.find((option) => option.value === theme.agentTaskLifecyclePolicy)
      ?.label ?? theme.agentTaskLifecyclePolicy,
  );

  function selectTaskLifecyclePolicy(value: AgentTaskLifecyclePolicy) {
    theme.setPersonal("agentTaskLifecyclePolicy", value);
    requestInputFocus();
  }

  function commitCompletedRetentionDays(value: number) {
    const days = Number.isFinite(value)
      ? Math.max(1, Math.min(365, Math.floor(value)))
      : theme.sidebarCompletedRetentionDays;
    theme.setPersonal("sidebarCompletedRetentionDays", days);
  }

  // ─── Search ───


  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));
</script>

<SettingsSection
  label="Task behavior"
  visible={["task-lifecycle", "completed-retention"].some(isVisible)}
>
  <SettingsRow
    label="Task lifecycle control"
    managed={managedSetting("agentTaskLifecyclePolicy")}
    description="None: no changes. Moderate: Done is yours. Autonomous: full control."
    visible={isVisible("task-lifecycle")}
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
              aria-label="Task lifecycle control"
              class="min-w-28 justify-between text-xs font-normal shadow-xs"
            >
              <span>{taskLifecyclePolicyLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[160px]"
        >
          <DropdownMenu.RadioGroup value={theme.agentTaskLifecyclePolicy}>
            {#each taskLifecyclePolicies as option (option.value)}
              <DropdownMenu.RadioItem
                value={option.value}
                onSelect={() => selectTaskLifecyclePolicy(option.value)}
              >
                {option.label}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Completed task history"
    description="Days to keep completed tasks in the sidebar."
    visible={isVisible("completed-retention")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-input bg-white shadow-xs/5 dark:bg-input/30"
      >
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays - 1,
            )}
          aria-label="Decrease completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >&minus;</button
        >
        <Input
          type="number"
          min={1}
          max={365}
          step={1}
          value={String(theme.sidebarCompletedRetentionDays)}
          aria-label="Completed task history in days"
          onchange={(event) => {
            commitCompletedRetentionDays(
              Number((event.target as HTMLInputElement).value),
            );
            (event.target as HTMLInputElement).value = String(
              theme.sidebarCompletedRetentionDays,
            );
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">d</span>
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays + 1,
            )}
          aria-label="Increase completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)"
  >
    No settings match your search
  </div>
{/if}
