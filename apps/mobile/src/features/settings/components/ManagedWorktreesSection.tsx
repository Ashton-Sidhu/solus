import { useAtomValue } from "@effect/atom-react";
import { managedWorktreeState, type ManagedWorktree } from "@solus/contracts/git-types";
import { deleteConfirmText, worktreeStatusText } from "@solus/client-core/managed-worktrees";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { confirm } from "../../../components/ui/Dialog";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";
import { managedWorktrees, removeManagedWorktrees } from "../../../solus/managed-worktrees";
import { useHostQueryScope } from "../../../state/host-query-scope";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

type HostTarget = { readonly environmentId: EnvironmentId; readonly label: string };

export function ManagedWorktreesSection(props: HostTarget) {
  const scope = useHostQueryScope(props.environmentId);
  return <HostWorktrees key={scope} {...props} scope={scope} />;
}

function HostWorktrees({ environmentId, label, scope }: HostTarget & { readonly scope: string }) {
  const gt = useGT();
  const query = useEnvironmentQuery(managedWorktrees({ environmentId, input: null, scope }));
  const canWrite = useAtomValue(removeManagedWorktrees.permissionAtom(environmentId));
  const remove = useAtomCommand(removeManagedWorktrees, { reportFailure: false });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [messages, setMessages] = useState<{ status: string; error: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const worktrees = query.data ?? [];
  const available = worktrees.filter((row) => managedWorktreeState(row) !== "in_use");
  const selected = available.filter((row) => selection.has(row.path));
  const disabled = busy || !canWrite || !query.successResult;

  async function removeSelected(confirmed: ManagedWorktree[]) {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    setBusy(true);
    setDeleting(new Set(confirmed.map((row) => row.path)));
    setMessages(null);
    const response = await remove({ environmentId, input: { scope, worktrees: confirmed } });
    pending.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setDeleting(new Set());
    if (AsyncResult.isSuccess(response)) {
      const { removed, notices, failures } = response.value;
      const summary = removed > 0
        ? gt("Deleted {count, plural, one {# worktree} other {# worktrees}}.", { count: removed })
        : "";
      setSelection(new Set(failures.map((failure) => failure.path)));
      setMessages({
        status: [summary, ...notices].filter(Boolean).join("\n"),
        error: failures.map((failure) => failure.message).join("\n"),
      });
    } else if (AsyncResult.isFailure(response)) {
      const error = squashAtomCommandFailure(response);
      setMessages({
        status: "",
        error: error instanceof Error ? error.message : gt("Could not delete the selected worktrees."),
      });
    }
  }

  function confirmRemoval() {
    if (disabled || selected.length === 0) return;
    confirm({
      title: gt("Delete {count, plural, one {# worktree} other {# worktrees}}?", { count: selected.length }),
      message: selected.map((row) => `${row.title}\n${deleteConfirmText(row)}`).join("\n\n"),
      confirmText: selected.some((row) => managedWorktreeState(row) === "unsaved")
        ? gt("Delete and lose work")
        : gt("Delete"),
      destructive: true,
      onConfirm: () => void removeSelected(selected),
    });
  }

  return (
    <SettingsSection
      title={gt("Solus worktrees on {host}", { host: label })}
      trailing={<Button label={gt("Refresh")} size="compact" loading={query.isPending} disabled={busy} onPress={query.refresh} />}
    >
      {selected.length > 0 || busy ? (
        <View
          accessibilityRole="toolbar"
          accessibilityLabel={gt("Bulk actions")}
          className="flex-row flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2"
        >
          <Text className="mr-auto font-t3-medium tabular-nums">
            {gt("{count} selected", { count: selected.length })}
          </Text>
          <Button
            label={gt("Select all")}
            size="compact"
            tone="text"
            disabled={disabled || selected.length === available.length}
            onPress={() => setSelection(new Set(available.map((row) => row.path)))}
          />
          <Button
            label={busy ? gt("Deleting…") : gt("Delete")}
            size="compact"
            tone="danger"
            loading={busy}
            disabled={disabled}
            onPress={confirmRemoval}
          />
          <Button label={gt("Clear")} size="compact" tone="text" disabled={busy} onPress={() => setSelection(new Set())} />
        </View>
      ) : null}
      {query.error ? <Text accessibilityRole="alert" className="px-4 py-2 text-danger-foreground">{query.error}</Text> : null}
      {query.successResult && !worktrees.length ? <Text className="px-4 py-2">{gt("No worktrees on this host")}</Text> : null}
      {query.successResult && worktrees.length > 0 && !canWrite ? <Text className="px-4 py-2">{gt("This connection cannot delete worktrees.")}</Text> : null}
      {messages?.status ? <Text accessibilityLiveRegion="polite" className="px-4 py-2">{messages.status}</Text> : null}
      {messages?.error ? <Text accessibilityRole="alert" className="px-4 py-2 text-danger-foreground">{messages.error}</Text> : null}
      {worktrees.map((worktree) => {
        const inUse = managedWorktreeState(worktree) === "in_use";
        const checked = !inUse && selection.has(worktree.path);
        const rowDisabled = disabled || inUse;
        const description = deleting.has(worktree.path)
          ? `${worktree.group.name} · ${gt("Deleting…")}`
          : `${worktree.group.name} · ${worktreeStatusText(worktree)}`;
        return (
          <RowPressable
            key={worktree.path}
            accessibilityRole="checkbox"
            accessibilityLabel={worktree.title}
            accessibilityHint={description}
            accessibilityState={{ checked, disabled: rowDisabled }}
            disabled={rowDisabled}
            className={checked ? "border-t border-border-subtle bg-thread-selected" : "border-t border-border-subtle"}
            onPress={() => setSelection((current) => {
              const next = new Set(current);
              if (next.has(worktree.path)) next.delete(worktree.path);
              else next.add(worktree.path);
              return next;
            })}
          >
            <ListRowLayout
              label={worktree.title}
              description={description}
              leading={inUse ? <View className="size-5" /> : (
                <SymbolView
                  name={checked ? "checkmark.circle.fill" : "circle"}
                  tintColorClassName={checked ? "accent-primary-text" : "accent-foreground-muted"}
                  size={20}
                />
              )}
            />
          </RowPressable>
        );
      })}
    </SettingsSection>
  );
}
