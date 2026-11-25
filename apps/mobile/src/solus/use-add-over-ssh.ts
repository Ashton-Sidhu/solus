import { sshAddStatusCard } from "@solus/client-core/ssh-progress";
import type { SshAddProgress } from "@solus/contracts/remote-machines";
import type { StatusCardState } from "@solus/contracts/types";
import { useListened } from "@solus-mobile/app/app-context";
import {
  fixKeyAndRunSshAdd,
  isMissingIdentityFile,
  runSshAdd,
  sshAddFormIssue,
  sshAddOutcome,
  sshPasswordIssue,
  sshRunnerChoices,
  type SshAddForm,
  type SshAddOutcome,
  type SshRunner,
} from "@solus-mobile/features/hosts/lib/ssh-add";
import { useEffect, useRef, useState } from "react";

import { solus, useSolusWorkspace } from "./runtime";

/**
 * The Add over SSH sheet of the Add environment screen (docs/plans/host-routes.md
 * D6). A phone cannot run `ssh`: a connected host where this phone holds
 * `host.local.reach` runs it. A password or passphrase lives only in this
 * state until the one request that sends it.
 */

/** `form` waits on the person; `running` waits on the host; `done` shows what the add did. */
export type AddOverSshPhase = "form" | "running" | "done";

/** The connected hosts that may run SSH for this phone, the one it connected to last first. */
export function useSshRunners(): SshRunner[] {
  const { environments } = useSolusWorkspace();
  const connected = environments
    .filter((env) => env.connectionState === "connected")
    .map((env) => ({
      hostId: env.environmentId,
      label: env.environmentLabel,
      lastConnected: solus.registry.host(env.environmentId)?.lastConnected ?? 0,
    }));
  return sshRunnerChoices(connected, (hostId) => solus.connections.may(hostId, "host.local.reach"));
}

/** The hosts a finished add changed: the account's directory, or the runner's forwards. */
function afterAdded(outcome: SshAddOutcome, runnerHostId: string, syncSettings: boolean | null) {
  if (outcome.kind === "linked") {
    void solus.account.refreshDirectory();
    if (syncSettings !== null) solus.settingsSync.hostAdded(outcome.installationId, syncSettings);
  }
  if (outcome.kind === "forwarded") {
    void solus.forwardedHosts.load(runnerHostId);
    if (syncSettings !== null) solus.settingsSync.hostAdded(outcome.host.installationId, syncSettings);
  }
}

/** The typed values of the form. */
function useSshAddFields() {
  const [sshTarget, setSshTarget] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [shouldLink, setShouldLink] = useState(true);
  const [authSecret, setAuthSecret] = useState("");
  return { sshTarget, setSshTarget, identityFile, setIdentityFile, shouldLink, setShouldLink, authSecret, setAuthSecret };
}

/** What the host answered last: a request for a password, a key to fix, or an error. */
function useSshAddAnswers() {
  const [askAuth, setAskAuth] = useState<string | null>(null);
  const [keyFix, setKeyFix] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const clear = () => {
    setKeyFix(null);
    setIdentityError(null);
    setError(null);
  };
  return { askAuth, setAskAuth, keyFix, setKeyFix, identityError, setIdentityError, error, setError, note, setNote, clear };
}

export function useAddOverSsh(syncSettings: boolean | null) {
  const runners = useSshRunners();
  const [chosenRunnerId, setChosenRunnerId] = useState<string | null>(null);
  const runner = runners.find((host) => host.hostId === chosenRunnerId) ?? runners[0] ?? null;
  // Signed in, the account issues the ticket that links the new machine (as `uplinkStore.canLink` on desktop).
  const canLink = useListened(solus.account.changes, () => solus.account.isSignedIn);
  const fields = useSshAddFields();
  const answers = useSshAddAnswers();
  const [phase, setPhase] = useState<AddOverSshPhase>("form");
  const [steps, setSteps] = useState<readonly SshAddProgress[]>([]);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an answer that lands after the sheet closed changes nothing on screen
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const form: SshAddForm = {
    runnerHostId: runner?.hostId ?? null,
    sshTarget: fields.sshTarget,
    identityFile: fields.identityFile,
    shouldLink: fields.shouldLink && canLink,
    // The secret goes only into the add that follows the host's request for it.
    authSecret: answers.askAuth !== null ? fields.authSecret : "",
  };

  const show = (outcome: SshAddOutcome, runnerHostId: string) => {
    if (outcome.kind === "ask-auth") answers.setAskAuth(outcome.message);
    else if (outcome.kind === "fix-key") answers.setKeyFix(outcome.message);
    else if (outcome.kind === "ask-target") answers.setError(outcome.message);
    else {
      afterAdded(outcome, runnerHostId, syncSettings);
      answers.setNote(outcome.note);
      return setPhase("done");
    }
    setPhase("form");
  };

  const fail = (message: string) => {
    if (isMissingIdentityFile(message)) answers.setIdentityError(message);
    else answers.setError(message);
    setPhase("form");
  };

  /** Why Add cannot send now, or null; a password over a connection that is not encrypted is refused here. */
  const sendIssue = (): string | null => {
    const issue = sshAddFormIssue(form);
    if (issue || !runner || !form.authSecret) return issue;
    const connection = solus.connections.connection(runner.hostId);
    return sshPasswordIssue(connection, runner.label, solus.registry.host(runner.hostId)?.routes ?? []);
  };

  const run = async (fixKey: boolean) => {
    if (inFlight.current || phase === "running") return;
    answers.clear();
    const issue = sendIssue();
    const connection = runner ? solus.connections.connection(runner.hostId) : null;
    if (issue || !runner || !connection) {
      fields.setAuthSecret("");
      return answers.setError(issue ?? "The host that runs SSH cannot be reached now.");
    }
    inFlight.current = true;
    setPhase("running");
    setSteps([]);
    answers.setAskAuth(null);
    fields.setAuthSecret("");
    const options = {
      requestId: solus.platform.uuid(),
      deviceLabel: runner.label,
      issueTicket: () => solus.account.issueEnrollmentTicket(),
      onProgress: (progress: SshAddProgress) => {
        if (mounted.current) setSteps((current) => [...current, progress]);
      },
    };
    try {
      const result = await (fixKey ? fixKeyAndRunSshAdd : runSshAdd)(connection, form, options);
      if (mounted.current) show(sshAddOutcome(result, runner.label), runner.hostId);
    } catch (error) {
      if (mounted.current) fail(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  };

  const statusCard: StatusCardState | null =
    steps.length === 0 && phase !== "running"
      ? null
      : sshAddStatusCard(steps, {
          target: fields.sshTarget.trim(),
          standing: phase === "running" ? "running" : phase === "done" ? "done" : "failed",
          resultMessage: answers.note,
          error: answers.error ?? answers.askAuth ?? answers.keyFix ?? answers.identityError ?? "",
        });

  return {
    runners,
    runner,
    chooseRunner: setChosenRunnerId,
    canLink,
    ...fields,
    ...answers,
    phase,
    statusCard,
    add: () => void run(false),
    fixKeyAndAdd: () => void run(true),
  };
}

export type AddOverSshFlow = ReturnType<typeof useAddOverSsh>;
