import type { CloudMachineAsk } from "@solus/contracts/cloud-machine-card";
import { requestExpiryText } from "@solus/contracts/types";
import type { ManagedHostLifecycle } from "@solus/contracts/uplink";
import {
  asksOrganization,
  cardFacts,
  cardTitle,
  chosenAnswers,
  declinedAnswers,
  fieldsProblem,
  initialFields,
  packagesProblem,
  restartsOnSave,
  reviewLabel,
  sheetOffers,
  sheetTitle,
  sizeDetail,
  submitLabel,
  type CloudMachineFact,
  type CloudMachineFields,
} from "@solus-mobile/features/conversation/lib/cloud-machine-card";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { Sheet } from "../../components/ui/Sheet";
import { SettingsSection } from "../settings/components/SettingsSection";

// Adapted from the Add machine card (LinkRequestCard.tsx): the same card, Decline
// link, and Sheet with Settings choice rows, for the machine card of a cloud
// machine tool (question kind `cloud-machine`, plans/035-cloud-machine-tools.md §6).
// The card only collects the choices. The host tool answers itself after it gets them.

const STATE_PILL = {
  ready: { pillClassName: "bg-adaptive-emerald-500-a12-a16", textClassName: "text-adaptive-emerald-700-300" },
  provisioning: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  starting: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  stopping: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  deleting: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  stopped: { pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" },
  failed: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
} satisfies Record<ManagedHostLifecycle, Omit<StatusTone, "label">>;
const UNKNOWN_PILL = STATE_PILL.stopped;

export function CloudMachineCard(props: {
  readonly question: PendingQuestion;
  readonly ask: CloudMachineAsk;
  readonly responding: boolean;
  /** False for a reader who may only view the session: an editor answers. */
  readonly mayDrive: boolean;
  /** Sends the card's answers to the host with `respondQuestion`. */
  readonly onAnswer: (answers: Record<string, string>) => Promise<void>;
}) {
  const { ask } = props;
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(() => initialFields(ask));
  const canRespond = props.question.expired === undefined;
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <SymbolView
            name={ask.mode === "edit" ? "square.and.pencil" : "cloud"}
            size={16}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <Text className="font-t3-bold text-base text-foreground">{cardTitle(ask)}</Text>
        </View>
        {ask.reason.trim() ? (
          <Text selectable className="font-sans text-sm leading-5 text-foreground-muted">
            {ask.reason}
          </Text>
        ) : null}
      </View>
      <FactRows facts={cardFacts(ask, fields)} />
      {restartsOnSave(ask) ? <RestartWarning /> : null}
      {props.question.expired ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {requestExpiryText(props.question.expired)}
        </Text>
      ) : null}
      {!canRespond ? null : props.mayDrive ? (
        <>
          <Button
            label={reviewLabel(ask)}
            disabled={props.responding}
            onPress={() => setOpen(true)}
            tone="primary"
            fullWidth
          />
          <View className="flex-row justify-end">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: props.responding }}
              disabled={props.responding}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => void props.onAnswer(declinedAnswers())}
            >
              <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">Waiting for an editor</Text>
      )}
      {open && canRespond && props.mayDrive ? (
        <CloudMachineSheet
          ask={ask}
          fields={fields}
          onChange={(change) => setFields((current) => ({ ...current, ...change }))}
          disabled={props.responding}
          onSubmit={() => void props.onAnswer(chosenAnswers(ask, fields)).then(() => setOpen(false))}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** What the agent chose, and what is still missing, as label and value rows. */
function FactRows(props: { readonly facts: readonly CloudMachineFact[] }) {
  return (
    <View className="overflow-hidden rounded-xl border border-border">
      {props.facts.map((fact, index) => (
        <View
          key={fact.label}
          className={
            index > 0
              ? "flex-row items-center justify-between gap-3 border-t border-border px-3 py-2"
              : "flex-row items-center justify-between gap-3 px-3 py-2"
          }
        >
          <Text className="font-sans text-xs text-foreground-muted">{fact.label}</Text>
          {fact.state !== undefined ? (
            <StatusPill
              size="compact"
              label={fact.value}
              {...(fact.state ? STATE_PILL[fact.state] : UNKNOWN_PILL)}
            />
          ) : (
            <Text
              numberOfLines={1}
              className={
                fact.missing
                  ? "min-w-0 shrink font-t3-medium text-xs text-warning-foreground"
                  : "min-w-0 shrink text-right font-sans text-xs text-foreground"
              }
            >
              {fact.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function RestartWarning() {
  return (
    <View
      accessible
      accessibilityRole="alert"
      className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3 py-2.5"
    >
      <SymbolView name="exclamationmark.triangle" size={14} tintColorClassName="accent-warning-foreground" />
      <Text className="min-w-0 flex-1 font-sans text-xs leading-4 text-warning-foreground">
        The machine restarts to take the change. Its sessions stop.
      </Text>
    </View>
  );
}

function CloudMachineSheet(props: {
  readonly ask: CloudMachineAsk;
  readonly fields: CloudMachineFields;
  readonly onChange: (change: Partial<CloudMachineFields>) => void;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}) {
  const { ask, fields } = props;
  const insets = useSafeAreaInsets();
  const offers = sheetOffers(ask);
  const packages = packagesProblem(ask, fields);
  const problem = fieldsProblem(ask, fields);
  return (
    <Sheet title={sheetTitle(ask)} onClose={props.onClose} dismissDisabled={props.disabled}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        {ask.mode === "join" ? (
          <Text selectable className="font-mono text-sm text-foreground">
            {ask.address}
          </Text>
        ) : null}
        {ask.mode !== "edit" && asksOrganization(ask) ? (
          <SettingsSection title="Organization">
            {ask.organizations.map((organization, index) => (
              <SettingsChoiceRow
                key={organization.id}
                label={organization.name}
                selected={fields.organizationId === organization.id}
                separated={index > 0}
                disabled={props.disabled}
                onPress={() => props.onChange({ organizationId: organization.id })}
              />
            ))}
          </SettingsSection>
        ) : null}
        {offers.name ? (
          <Field title="Name">
            <TextInput
              accessibilityLabel="Name"
              placeholder="Cloud host"
              value={fields.name}
              onChangeText={(name) => props.onChange({ name })}
              editable={!props.disabled}
              autoCorrect={false}
            />
          </Field>
        ) : null}
        {offers.sizes && ask.mode === "create" ? (
          <SettingsSection title="Size">
            {ask.catalog.sizes.map((size, index) => (
              <SettingsChoiceRow
                key={size.id}
                label={size.label}
                description={sizeDetail(size)}
                selected={fields.size === size.id}
                separated={index > 0}
                disabled={props.disabled}
                onPress={() => props.onChange({ size: size.id })}
              />
            ))}
          </SettingsSection>
        ) : null}
        {offers.packages ? (
          <Field
            title="Packages"
            hint={ask.mode === "edit" ? "Leave empty to remove all packages." : "Separate with spaces."}
            problem={packages}
          >
            <TextInput
              accessibilityLabel="Packages"
              placeholder="docker.io jq"
              value={fields.packagesText}
              onChangeText={(packagesText) => props.onChange({ packagesText })}
              editable={!props.disabled}
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        ) : null}
        {offers.setupScript ? (
          <Field title="Setup script" hint="Runs at the next boot, after the packages install.">
            <TextInput
              accessibilityLabel="Setup script"
              placeholder="#!/bin/sh"
              value={fields.setupScript}
              onChangeText={(setupScript) => props.onChange({ setupScript })}
              editable={!props.disabled}
              multiline
              textAlignVertical="top"
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              className="min-h-32 font-mono text-sm"
            />
          </Field>
        ) : null}
        {problem && problem !== packages ? (
          <Text className="font-sans text-xs text-foreground-muted">{problem}</Text>
        ) : null}
        <Button
          label={props.disabled ? "Sending…" : submitLabel(ask)}
          disabled={props.disabled || problem !== null}
          onPress={props.onSubmit}
          tone="primary"
          fullWidth
        />
      </ScrollView>
    </Sheet>
  );
}

/** A typed value with its title, its hint, and the problem that blocks a submit. */
function Field(props: {
  readonly title: string;
  readonly hint?: string;
  readonly problem?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
      {props.problem ? (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {props.problem}
        </Text>
      ) : props.hint ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}
