<script lang="ts">
  import { Plus as AddIcon, X as RemoveIcon } from "@lucide/svelte";
  import { DEPLOYMENT_ROLE_OPTIONS, subjectCandidates, subjectRows, withSubject, withoutSubject, type SubjectDirectory } from "@solus/client-core/app-deployment";
  import type { AppAccessSubject } from "@solus/contracts/app-deployments";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";

  /**
   * Who opens a published app with the access "People you name"
   * (docs/plans/app-deploy.md §7.3): the organization, its teams, and its
   * people, each with what they may do. The owner always opens the app, so
   * the list does not name them. The list is the caller's to save: a change
   * here goes to `onChange` and nowhere else.
   */
  interface Props {
    subjects: AppAccessSubject[];
    /** The people and teams of the owner's organization; null while it loads, and for an account in no organization. */
    directory: SubjectDirectory | null;
    /** The owner's user key, so the list does not offer them. */
    ownerKey: string | null;
    disabled: boolean;
    onChange: (subjects: AppAccessSubject[]) => void;
  }
  let { subjects, directory, ownerKey, disabled, onChange }: Props = $props();

  const rows = $derived(subjectRows(subjects, directory));
  const candidates = $derived(subjectCandidates(subjects, directory, ownerKey));
</script>

<div class="flex min-w-0 flex-col gap-1" data-testid="app-deployment-people">
  {#each rows as row (`${row.subject.kind}:${row.subject.id}`)}
    <div class="flex min-h-9 min-w-0 items-center gap-2">
      <span class="flex min-w-0 flex-1 flex-col leading-tight">
        <span class="truncate text-[13px] text-foreground">{row.name}</span>
        {#if row.detail}
          <span class="truncate text-xs text-muted-foreground">{row.detail}</span>
        {/if}
      </span>
      <SettingsSelect
        compact
        ariaLabel="What {row.name} does"
        options={DEPLOYMENT_ROLE_OPTIONS}
        value={row.role}
        {disabled}
        onSelect={(role) => {
          if (role !== row.role) onChange(withSubject(subjects, row.subject, role));
        }}
      />
      <Button
        size="icon-xs"
        variant="ghost"
        class="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:tap-area"
        title="Remove {row.name}"
        aria-label="Remove {row.name}"
        {disabled}
        onclick={() => onChange(withoutSubject(subjects, row.subject))}
      >
        <RemoveIcon size={14} />
      </Button>
    </div>
  {:else}
    <p class="m-0 text-[13px] text-muted-foreground">Only you open the app now.</p>
  {/each}

  {#if directory === null}
    <p class="m-0 text-xs text-muted-foreground text-pretty">Your account works in no organization, so there is nobody to name. Use a link to give the app to a person.</p>
  {:else if candidates.length > 0}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} size="sm" variant="outline" class="mt-1 self-start" {disabled} data-testid="app-deployment-people-add">
            <AddIcon size={14} /> Add
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="max-h-80 w-[min(20rem,calc(100vw-2rem))] overflow-y-auto">
        {#each candidates as candidate (`${candidate.subject.kind}:${candidate.subject.id}`)}
          <DropdownMenu.Item class="h-auto py-1.5" onSelect={() => onChange(withSubject(subjects, candidate.subject, "editor"))}>
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="truncate">{candidate.name}</span>
              {#if candidate.detail}
                <span class="truncate text-[0.875em] text-muted-foreground">{candidate.detail}</span>
              {/if}
            </span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</div>
