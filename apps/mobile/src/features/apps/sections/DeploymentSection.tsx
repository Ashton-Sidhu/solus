import { useCallback, useState } from "react";
import { Alert, Linking, View } from "react-native";

import {
  DEFAULT_DEPLOYMENT_CHOICES,
  DEPLOYMENT_ACCESS_OPTIONS,
  DEPLOYMENT_ROLE_OPTIONS,
  UNKNOWN_PUBLISH_PLACES,
  UNPUBLISH_QUESTION,
  deploymentAccessText,
  deploymentAddressNote,
  deploymentAddressText,
  deploymentCallsText,
  deploymentChangeQuestion,
  deploymentPlaceOf,
  deploymentPlaceOptions,
  deploymentPlaceProblem,
  deploymentPlaceValue,
  deploymentRoleText,
  deploymentState,
  deploymentStateText,
  firstPublishRequest,
  hasOneVisitorRole,
  offersTailscaleAddress,
  publishAgainRequest,
  publishRefusalText,
  subjectsSummary,
  versionToPublish,
  type DeploymentChange,
  type DeploymentChoices,
  type DeploymentQuestion,
} from "@solus/client-core/app-deployment";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppDeploymentView, AppPublishPlaces, AppPublishRequest } from "@solus/contracts/app-deployments";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { SettingsChoiceRow } from "../../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";
import { errorMessage } from "../../settings/integrations";
import type { RowLine } from "../../webhooks/webhook-rows";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow, CopyPill, MonoBlock, ReadBody } from "../app-rows";
import type { AppItemState } from "../app-states";
import { agoText } from "../apps";
import { useAppChange, useAppRead, useHostRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

const DEPLOYMENT_MARKS = {
  running: "ok",
  "not-answering": "warning",
  stopped: "stopped",
  "host-unreachable": "warning",
} as const satisfies { [State in ReturnType<typeof deploymentState>]: AppItemState };

/** The phone has no picker for the people and teams of an organization, as for a session or an automation of a signal action. */
const PEOPLE_NOTE = "Name the people, the teams, or the organization on desktop or on the web. The owner always opens the app.";

const readPublishPlaces = (api: HostApi) => api.appPublishPlaces();

/** What the host of the app has for a publish. A host that cannot say is taken to have each thing, and says what it lacks at the publish. */
function usePublishPlaces(hostId: string): AppPublishPlaces {
  const places = useHostRead(hostId, readPublishPlaces);
  return places.state.kind === "loaded" ? places.state.value : UNKNOWN_PUBLISH_PLACES;
}

/** Asks before a change, with the way back first. A change that needs no question runs at once. */
function ask(question: DeploymentQuestion | null, run: () => void, isDestructive = false) {
  if (!question) {
    run();
    return;
  }
  Alert.alert(question.title, question.detail, [
    { text: "Cancel", style: "cancel" },
    { text: question.confirm, style: isDestructive ? "destructive" : "default", onPress: run },
  ]);
}

/**
 * Deployment (docs/plans/app-deploy.md §9): the published copy of the app's
 * active version, in a container of its own. An app that is not published
 * shows the choices of a first publish. A published one shows how the copy
 * is, its address and its link, who opens it, its log, and Unpublish. Each
 * change is a publish; one that puts a visitor out or sends a new version
 * asks first.
 */
export function DeploymentSection({ hostId, appId, state, connected }: AppSectionProps) {
  const readDeployment = useCallback((api: HostApi) => api.appDeployment({ appId }), [appId]);
  const deployment = useAppRead(hostId, appId, "deployment", readDeployment);
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const { activeVersion } = state.app;
  /** Why the last publish did not work. It stays on the screen: the words say what to do. */
  const [problem, setProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<DeploymentChoices>(DEFAULT_DEPLOYMENT_CHOICES);

  const publish = (request: AppPublishRequest) => {
    setProblem(null);
    change("publish", (api) => api.appPublish(request)).then(
      (receipt) => {
        setProblem(publishRefusalText(receipt));
        deployment.reload();
      },
      (cause: unknown) => setProblem(errorMessage(cause)),
    );
  };

  const unpublish = () => {
    setProblem(null);
    change("unpublish", (api) => api.appUnpublish({ appId })).then(deployment.reload, (cause: unknown) => setProblem(errorMessage(cause)));
  };

  return (
    <View className="gap-3">
      {problem ? <ErrorBanner message={problem} /> : null}
      <ReadBody read={deployment.state} connected={connected} subject="The deployment" onRetry={deployment.reload}>
        {(view) =>
          view ? (
            <Published
              hostId={hostId}
              appId={appId}
              view={view}
              activeVersion={activeVersion}
              connected={connected}
              disabled={disabled}
              isPublishing={busy === "publish"}
              onChange={(next) => ask(deploymentChangeQuestion(next, view, activeVersion), () => publish(publishAgainRequest(appId, view, next)))}
              onUnpublish={() => ask(UNPUBLISH_QUESTION, unpublish, true)}
            />
          ) : (
            <FirstPublish
              hostId={hostId}
              choices={choices}
              activeVersion={activeVersion}
              disabled={disabled}
              isPublishing={busy === "publish"}
              onChoose={(next) => setChoices({ ...choices, ...next })}
              onPublish={() => publish(firstPublishRequest(appId, choices))}
            />
          )
        }
      </ReadBody>
    </View>
  );
}

/** One choice among a few, as a group of rows with a mark on the chosen one. */
function ChoiceGroup<Value extends string>(props: {
  readonly title: string;
  readonly footer?: string;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly value: Value;
  readonly disabled: boolean;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <SettingsSection title={props.title} footer={props.footer}>
      {props.options.map((option, index) => (
        <SettingsChoiceRow
          key={option.value}
          label={option.label}
          selected={option.value === props.value}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => {
            if (option.value !== props.value) props.onSelect(option.value);
          }}
        />
      ))}
    </SettingsSection>
  );
}

function FirstPublish(props: {
  readonly hostId: string;
  readonly choices: DeploymentChoices;
  readonly activeVersion: number | null;
  readonly disabled: boolean;
  readonly isPublishing: boolean;
  readonly onChoose: (next: Partial<DeploymentChoices>) => void;
  readonly onPublish: () => void;
}) {
  const { choices, activeVersion } = props;
  const places = usePublishPlaces(props.hostId);
  const placeProblem = deploymentPlaceProblem(places.places, choices);
  const lacksKey = choices.hostId === null && !places.hasTailscaleKey;
  const cannotName = choices.access === "people" && !places.canNamePeople;
  return (
    <View className="gap-5">
      <SettingsNote>
        A copy of the active version in a container of its own, with an address that a browser opens. Publish it to give the app to people who do not have Solus.
      </SettingsNote>
      <ChoiceGroup
        title="Where it runs"
        footer={placeProblem ?? "The copy has its own data. The app in Solus does not change."}
        options={deploymentPlaceOptions(places.places)}
        value={deploymentPlaceValue(choices)}
        disabled={props.disabled}
        onSelect={(value) => props.onChoose(deploymentPlaceOf(value))}
      />
      {offersTailscaleAddress(choices.platform) ? (
        <SettingsSection
          footer={
            lacksKey
              ? "An address on your tailnet. This host has no Tailscale auth key: set it in the settings of the host."
              : "An address on your tailnet, with HTTPS, that your other devices open. Without it, the address opens only on the host that runs the container."
          }
        >
          <SettingsSwitchRow
            label="Tailscale address"
            value={choices.tailscaleAddress && !lacksKey}
            disabled={props.disabled || lacksKey}
            onValueChange={(tailscaleAddress) => props.onChoose({ tailscaleAddress })}
          />
        </SettingsSection>
      ) : null}
      <ChoiceGroup
        title="Who opens it"
        footer={cannotName ? "To name people, sign in to Solus on the host of the app." : choices.access === "people" ? `${deploymentAccessText(choices.access)} ${PEOPLE_NOTE}` : deploymentAccessText(choices.access)}
        options={DEPLOYMENT_ACCESS_OPTIONS}
        value={choices.access}
        disabled={props.disabled}
        onSelect={(access) => props.onChoose({ access })}
      />
      {hasOneVisitorRole(choices.access) ? (
        <ChoiceGroup
          title="What a visitor does"
          footer={deploymentRoleText(choices.role)}
          options={DEPLOYMENT_ROLE_OPTIONS}
          value={choices.role}
          disabled={props.disabled}
          onSelect={(role) => props.onChoose({ role })}
        />
      ) : null}
      {activeVersion === null ? (
        <SettingsNote>This app has no active version. Deploy one, then publish it.</SettingsNote>
      ) : (
        <PillButton
          label={props.isPublishing ? "Publishing…" : `Publish version ${activeVersion}`}
          disabled={props.disabled || placeProblem !== null || cannotName}
          onPress={props.onPublish}
        />
      )}
    </View>
  );
}

function Published(props: {
  readonly hostId: string;
  readonly appId: string;
  readonly view: AppDeploymentView;
  readonly activeVersion: number | null;
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly isPublishing: boolean;
  readonly onChange: (change: DeploymentChange) => void;
  readonly onUnpublish: () => void;
}) {
  const { view, activeVersion, disabled } = props;
  const places = usePublishPlaces(props.hostId);
  const lacksKey = !view.host && !places.hasTailscaleKey && !view.tailscaleAddress;
  const [isLogOpen, setLogOpen] = useState(false);
  const behindVersion = versionToPublish(view, activeVersion);
  const addressNote = deploymentAddressNote(view);
  const lines: RowLine[] = [
    { text: [`Published ${agoText(view.publishedAt, Date.now())}`, deploymentCallsText(view)].filter(Boolean).join(" · ") },
    {
      text:
        behindVersion === null
          ? "The copy has the active version. Publish again after you change a secret of the app."
          : `Version ${behindVersion} is active in Solus, and the copy runs version ${view.version}. A deploy in Solus does not reach the copy.`,
    },
  ];
  const { address, link } = view;

  return (
    <View className="gap-5">
      <SettingsSection title="Deployment">
        <AppDetailRow first mark={{ state: DEPLOYMENT_MARKS[deploymentState(view)] }} title={deploymentStateText(view)} titleLines={3} lines={lines}>
          <PillButton
            label={props.isPublishing ? "Publishing…" : behindVersion === null ? "Publish again" : `Publish version ${behindVersion}`}
            disabled={disabled || activeVersion === null}
            onPress={() => props.onChange({ kind: "again" })}
          />
        </AppDetailRow>
        {address && link ? (
          <AppDetailRow
            first={false}
            title={deploymentAddressText(address)}
            titleLines={2}
            lines={[{ text: addressNote ?? (view.access === "link" ? "Give a person the link: it is the address with the secret that opens the app." : "Each person who has the address opens the app.") }]}
          >
            <CopyPill label={view.access === "link" ? "Copy link" : "Copy address"} target={view.access === "link" ? "link of the app" : "address of the app"} value={link} />
            {addressNote ? null : <PillButton label="Open" onPress={() => void Linking.openURL(link)} />}
            {view.access === "link" ? <PillButton label="New link" disabled={disabled} onPress={() => props.onChange({ kind: "new-link" })} /> : null}
          </AppDetailRow>
        ) : null}
      </SettingsSection>

      <PublishedAccess view={view} canNamePeople={places.canNamePeople} disabled={disabled} onChange={props.onChange} />

      {offersTailscaleAddress(view.platform) ? (
        <>
          <SettingsSection
            footer={
              lacksKey
                ? "An address on your tailnet. This host has no Tailscale auth key: set it in the settings of the host."
                : "An address on your tailnet, with HTTPS, that your other devices open."
            }
          >
            <SettingsSwitchRow
              label="Tailscale address"
              value={view.tailscaleAddress}
              disabled={disabled || lacksKey}
              onValueChange={(isOn) => props.onChange({ kind: "tailscale", isOn })}
            />
          </SettingsSection>
          <View className="gap-2">
            <PillButton label={isLogOpen ? "Hide the log" : "Show the log"} onPress={() => setLogOpen(!isLogOpen)} />
            {isLogOpen ? <DeploymentLog hostId={props.hostId} appId={props.appId} connected={props.connected} /> : null}
          </View>
        </>
      ) : null}

      <View className="gap-2">
        <PillButton label="Unpublish" disabled={disabled} onPress={props.onUnpublish} />
        <SettingsNote>Unpublish removes the copy with the data it holds. The app in Solus does not change.</SettingsNote>
      </View>
    </View>
  );
}

/** Who opens the published copy and what a visitor does there, and where its webhooks arrive. */
function PublishedAccess(props: {
  readonly view: AppDeploymentView;
  readonly canNamePeople: boolean;
  readonly disabled: boolean;
  readonly onChange: (change: DeploymentChange) => void;
}) {
  const { view, disabled } = props;
  return (
    <>
      <ChoiceGroup
        title="Who opens it"
        footer={
          view.access === "people"
            ? `${subjectsSummary(view.subjects)}. ${PEOPLE_NOTE}`
            : props.canNamePeople
              ? deploymentAccessText(view.access)
              : `${deploymentAccessText(view.access)} To name people, sign in to Solus on the host of the app.`
        }
        options={DEPLOYMENT_ACCESS_OPTIONS}
        value={view.access}
        disabled={disabled}
        // The list of before comes back with the access that uses it.
        onSelect={(access) => props.onChange(access === "people" ? { kind: "people", subjects: view.subjects } : { kind: "access", access })}
      />
      {hasOneVisitorRole(view.access) ? (
        <ChoiceGroup
          title="What a visitor does"
          footer={deploymentRoleText(view.role)}
          options={DEPLOYMENT_ROLE_OPTIONS}
          value={view.role}
          disabled={disabled}
          onSelect={(role) => props.onChange({ kind: "role", role })}
        />
      ) : null}

      {view.webhooks.length > 0 ? (
        <SettingsSection title="Webhooks of the copy" footer="Where another service sends each webhook to the copy. The signing secret is the one in Webhooks.">
          {view.webhooks.map((webhook, index) => (
            <AppDetailRow key={webhook.name} first={index === 0} title={webhook.name} lines={[{ text: deploymentAddressText(webhook.url) }]}>
              <CopyPill label="Copy URL" target="webhook URL" value={webhook.url} />
            </AppDetailRow>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

/** The newest lines that the container wrote. Read when the person opens it, and when the deployment changes. */
function DeploymentLog(props: { readonly hostId: string; readonly appId: string; readonly connected: boolean }) {
  const { appId } = props;
  const readLog = useCallback((api: HostApi) => api.appDeploymentLogs({ appId }), [appId]);
  const log = useAppRead(props.hostId, appId, "deployment", readLog);
  return (
    <ReadBody read={log.state} connected={props.connected} subject="The log" onRetry={log.reload}>
      {(text) => (
        <View className="gap-2">
          {text ? <MonoBlock text={text} /> : <SettingsNote>The container wrote no text.</SettingsNote>}
          <PillButton label="Read again" onPress={log.reload} />
        </View>
      )}
    </ReadBody>
  );
}
