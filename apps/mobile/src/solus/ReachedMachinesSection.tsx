import { useEffect, useState } from "react";
import { View } from "react-native";
import { isReachFailing, reachedMachineDetail } from "@solus/client-core/reached-machines";
import { useListened } from "@solus-mobile/app/app-context";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/cn";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/** The rows shown before "Show N more", as on desktop. */
const FIRST_ROWS = 8;

/**
 * The machines this host reaches as the owner (docs/plans/host-reach.md): each
 * pairing with its health, and each introduction. Read-only: a person's machines
 * reach each other with no step. Shown to the host's local owner only.
 */
export function ReachedMachinesSection({ hostId }: { hostId: string }) {
  const view = useListened(solus.hostReach.changes, () => solus.hostReach.viewOf(hostId));
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => solus.hostReach.watch(hostId), [hostId]);
  if (view.kind === "hidden") return null;
  const machines = view.kind === "loaded" ? view.machines : [];
  const rows = isExpanded ? machines : machines.slice(0, FIRST_ROWS);
  return (
    <SettingsSection
      title="Machines it reaches"
      footer="Your machines reach each other with no step. Agents here can start sessions on each of these."
    >
      {view.kind === "error" ? (
        <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
          {view.message}
        </AppText>
      ) : view.kind === "reading" ? (
        <AppText className="px-4 py-3 text-sm text-foreground-muted">
          Reading the machines it reaches…
        </AppText>
      ) : machines.length === 0 ? (
        <AppText className="px-4 py-3 text-sm text-foreground-muted">
          It reaches no other machine yet. Add a machine, and your machines reach it too.
        </AppText>
      ) : (
        <>
          {rows.map((machine, index) => (
            <View
              key={machine.installationId}
              accessible
              accessibilityLabel={`${machine.label}, ${reachedMachineDetail(machine)}`}
              className={cn("gap-1 px-4 py-3", index > 0 && "border-t border-border-subtle")}
            >
              <AppText numberOfLines={1} className="text-base text-foreground">
                {machine.label}
              </AppText>
              <AppText
                numberOfLines={1}
                className={cn(
                  "text-sm",
                  isReachFailing(machine) ? "text-danger-foreground" : "text-foreground-muted",
                )}
              >
                {reachedMachineDetail(machine)}
              </AppText>
            </View>
          ))}
          {machines.length > FIRST_ROWS ? (
            <View className="border-t border-border-subtle px-2 py-1">
              <Button
                label={isExpanded ? "Show fewer machines" : `Show ${machines.length - FIRST_ROWS} more`}
                tone="text"
                size="compact"
                onPress={() => setIsExpanded(!isExpanded)}
              />
            </View>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
