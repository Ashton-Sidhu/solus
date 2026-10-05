<script lang="ts">
  import { Archive as ArchiveIcon, ArchiveRestore as RestoreIcon, Circle as UnreadIcon, CircleCheck as ReadIcon } from "@lucide/svelte";
  import type { HubNotification } from "@solus/contracts/notification-hub";
  import { attributionLabel } from "@solus/contracts/user";
  import { notificationAge, notificationError, notificationHeadline } from "@solus/client-core/notifications/presentation";

  /**
   * One notification. The row opens its resource; the two trailing controls set
   * read and archived. Both controls are disabled while the source is offline or
   * a choice for this row is waiting for its answer.
   */
  interface Props {
    notification: HubNotification;
    sourceLabel: string;
    openLabel: string;
    canChange: boolean;
    /** Why the controls are disabled, when they are. */
    disabledReason?: string;
    now: number;
    onOpen: () => void;
    onSetRead: (read: boolean) => void;
    onSetArchived: (archived: boolean) => void;
  }
  let { notification, sourceLabel, openLabel, canChange, disabledReason, now, onOpen, onSetRead, onSetArchived }: Props = $props();

  const isUnread = $derived(notification.readAt === null);
  const isArchived = $derived(notification.archivedAt !== null);
  const error = $derived(notificationError(notification));
</script>

<div
  class="group flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] focus-within:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] pointer-coarse:py-3"
  data-testid="notification-row"
>
  <span class="mt-1.5 flex size-2 shrink-0 items-center justify-center" aria-hidden="true">
    {#if isUnread}<span class="size-2 rounded-full bg-primary"></span>{/if}
  </span>
  <button
    type="button"
    class="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden text-left focus-visible:outline-none"
    onclick={onOpen}
    title={openLabel}
    aria-label="{notificationHeadline(notification)}: {notification.summary.title}. {openLabel}"
  >
    <span class="flex w-full min-w-0 items-baseline gap-2">
      <span class="truncate text-workspace-chrome {isUnread ? 'font-medium text-foreground' : 'text-[color-mix(in_oklch,var(--foreground)_80%,transparent)]'}">{notification.summary.title}</span>
      <span class="ml-auto shrink-0 text-chrome-dense text-muted-foreground tabular-nums">{notificationAge(notification.createdAt, now)}</span>
    </span>
    <span class="flex w-full min-w-0 items-baseline gap-1.5 text-chrome-dense text-muted-foreground">
      <span class="shrink-0">{notificationHeadline(notification)}</span>
      <span class="shrink-0 opacity-50" aria-hidden="true">·</span>
      <span class="truncate">{attributionLabel(notification.by)}</span>
      {#if notification.summary.detail}
        <span class="shrink-0 opacity-50" aria-hidden="true">·</span>
        <span class="truncate">{notification.summary.detail}</span>
      {/if}
      <span class="shrink-0 opacity-50" aria-hidden="true">·</span>
      <span class="truncate">{sourceLabel}</span>
    </span>
    {#if error}
      <span class="w-full truncate text-chrome-dense text-destructive">{error}</span>
    {/if}
  </button>
  <span class="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-11"
      disabled={!canChange}
      title={canChange ? (isUnread ? "Mark as read" : "Mark as unread") : disabledReason}
      aria-label={isUnread ? "Mark as read" : "Mark as unread"}
      onclick={() => onSetRead(isUnread)}
    >
      {#if isUnread}<ReadIcon size={16} />{:else}<UnreadIcon size={16} />{/if}
    </button>
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-11"
      disabled={!canChange}
      title={canChange ? (isArchived ? "Restore" : "Archive") : disabledReason}
      aria-label={isArchived ? "Restore" : "Archive"}
      onclick={() => onSetArchived(!isArchived)}
    >
      {#if isArchived}<RestoreIcon size={16} />{:else}<ArchiveIcon size={16} />{/if}
    </button>
  </span>
</div>
