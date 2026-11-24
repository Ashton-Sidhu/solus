import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { linkMachines, machineLinkChoices, type MachineLinkOutcome } from "@solus/client-core/host-linking";
import { routeKindLabel } from "@solus/client-core/host-route-control";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useMachineLinks } from "../../solus/use-machine-links";
import { SettingsSection } from "../settings/components/SettingsSection";

export function LinkSeveralEnvironmentsAction(props: {
  readonly environmentId: string;
  readonly environmentLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const machines = useMachineLinks();
  const source = machines.find(({ info }) => info.installationId === props.environmentId);
  if (!source && !open) return null;
  return (
    <View className="mt-3">
      <Button label="Link machines…" disabled={!source?.snapshot} onPress={() => setOpen(true)} fullWidth />
      {open ? (
        <LinkSeveralSheet {...props} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
}

function LinkSeveralSheet(props: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const machines = useMachineLinks();
  const source = machines.find(({ info }) => info.installationId === props.environmentId);
  const choices = source ? machineLinkChoices(source, machines) : [];
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, MachineLinkOutcome>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const chosen = choices.filter(({ id }) => selected.has(id) && outcomes.get(id) !== "linked");
  const selectable = choices.filter(({ id }) => outcomes.get(id) !== "linked");
  const allChosen = chosen.length > 0 && chosen.length === selectable.length;
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const submit = async () => {
    if (inFlight.current || !source || !chosen.length) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await linkMachines(source, chosen, (id, outcome) => {
        setOutcomes((current) => new Map(current).set(id, outcome));
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const failed = [...outcomes.values()].filter((outcome) => outcome === "failed").length;
  return (
    <Sheet title={`Link machines from ${props.environmentLabel}`} onClose={props.onClose} dismissDisabled={busy}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {props.environmentLabel} will get owner access on each selected machine.
        </Text>
        {choices.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            {source ? "No other machine with a pairing route is available." : "Reconnect to the source machine to continue."}
          </Text>
        ) : (
          <>
            <SettingsSection title="Machines">
              {choices.map(({ id, label, route, viaLabel }, index) => {
                const outcome = outcomes.get(id);
                const checked = selected.has(id);
                return (
                  <Pressable key={id} accessibilityRole="checkbox" accessibilityLabel={label}
                    accessibilityState={{ checked, disabled: busy || outcome === "linked" }}
                    className={index ? "gap-1 border-t border-border-subtle p-4" : "gap-1 p-4"}
                    disabled={busy || outcome === "linked"} onPress={() => toggle(id)}>
                    <Text className="text-base text-foreground">{checked ? "✓ " : ""}{label}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {routeKindLabel(route.kind)} · {route.url}{viaLabel ? ` · via ${viaLabel}` : ""}
                    </Text>
                    {outcome === "failed" ? <Text className="text-danger-foreground">Link failed</Text> : null}
                  </Pressable>
                );
              })}
            </SettingsSection>
            <Button label={allChosen ? "Select none" : "Select all"} tone="text" size="compact"
              disabled={busy || selectable.length === 0}
              onPress={() => setSelected(new Set(allChosen ? [] : selectable.map(({ id }) => id)))} />
          </>
        )}
        {outcomes.size > 0 && !busy ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {failed ? `Linked ${outcomes.size - failed} of ${outcomes.size}. The failed machines stay selected.` : "Links added."}
          </Text>
        ) : null}
        <Button label={busy ? "Linking…" : `Link ${chosen.length} ${chosen.length === 1 ? "machine" : "machines"}`}
          disabled={busy || chosen.length === 0} onPress={() => void submit()} tone="primary" fullWidth />
        <Button label={outcomes.size ? "Done" : "Cancel"} tone="secondary" disabled={busy} onPress={props.onClose} fullWidth />
      </ScrollView>
    </Sheet>
  );
}
