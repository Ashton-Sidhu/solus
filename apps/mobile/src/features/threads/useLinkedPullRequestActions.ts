import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { resourceRoleAtLeast } from "@solus/contracts/sharing";
import { watchRefusalMessage } from "@solus-mobile/features/threads/threadListV2";
import { solus } from "../../solus/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { canStartThreadPullRequestWatch } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { MenuProps } from "../../components/ui/Menu.types";

type MenuAction = MenuProps["actions"][number];

export function useLinkedPullRequestActions(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
  readonly connected: boolean;
}) {
  const gt = useGT();
  const { thread, project, connected } = input;
  const terminology = sourceControlClients.get(project?.repositoryIdentity?.provider).changeRequest;
  const session = thread && solus.threads.thread(thread.environmentId, thread.id);
  const canEdit = connected && resourceRoleAtLeast(session?.record.role ?? "none", "editor");
  const canStartWatch = canEdit && thread !== null && canStartThreadPullRequestWatch(thread);
  const links = session && (solus.threadList.facts().pullRequests.get(session.key) ?? session.record.pullRequests);
  const isWatching = (link: ThreadPullRequestLink) =>
    links?.some(raw => raw.repository === `${link.host}/${link.repository}` && raw.number === link.number && raw.watch !== undefined) === true;

  const run = (failureTitle: string, pending: Promise<void>) => {
    void pending.catch(error => Dialog.alert(failureTitle, error instanceof Error ? error.message : String(error)));
  };

  const setLinked = (
    reference: { host: string; repository: string; number: number; url: string },
    linked: boolean,
  ) => {
    if (!thread || !canEdit) return;
    run(
      linked
        ? gt("Couldn't link this pull request")
        : gt("Couldn't unlink this pull request"),
      linked
        ? solus.threadList.linkPullRequest(thread.environmentId, thread.id, reference.url)
        : solus.threadList.unlinkPullRequest(thread.environmentId, thread.id, {
            repository: `${reference.host}/${reference.repository}`, number: reference.number,
          }),
    );
  };

  const promptLink = () => {
    const term = changeRequestTermKind(terminology);
    Dialog.prompt({
      title: gt(
        "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
        { term },
      ),
      message: gt(
        "{term, select, mr {Paste a merge request URL, or enter 123 / #123 for this thread's repository.} cr {Paste a change request URL, or enter 123 / #123 for this thread's repository.} other {Paste a pull request URL, or enter 123 / #123 for this thread's repository.}}",
        { term },
      ),
      placeholder: gt(
        "{term, select, mr {Merge request URL or #42} cr {Change request URL or #42} other {Pull request URL or #42}}",
        { term },
      ),
      initialValue: "",
      confirmText: gt("Link", { $context: "verb, confirms linking a pull request" }),
      onConfirm: (reference) => {
        const [host, owner, repo] = session?.record.projectRemote?.split("/") ?? [];
        const repository = owner && repo ? `${owner}/${repo}` : null;
        const linkedProject = pullRequestLinkProject(project?.repositoryIdentity) ??
          (host === "github.com" && repository ? {
            host, repository, terminology,
            webUrl: (number: number) => `https://${host}/${repository}/pull/${number}`,
          } : null);
        const resolved = resolveLinkPullRequestInput(
          {
            reference,
            project: linkedProject,
            hasProject: () => true,
          },
          m,
        );
        if (resolved === null) {
          Dialog.alert(
            gt(
              "{term, select, mr {Couldn't link this merge request} cr {Couldn't link this change request} other {Couldn't link this pull request}}",
              { term },
            ),
            gt(
              "{term, select, mr {Use a merge request URL, 123, or #123.} cr {Use a change request URL, 123, or #123.} other {Use a pull request URL, 123, or #123.}}",
              { term },
            ),
          );
          return;
        }
        if ("error" in resolved) {
          Dialog.alert(
            gt(
              "{term, select, mr {Couldn't link this merge request} cr {Couldn't link this change request} other {Couldn't link this pull request}}",
              { term },
            ),
            resolved.error,
          );
          return;
        }
        setLinked(resolved.link, true);
      },
    });
  };

  const menuActions = (link: ThreadPullRequestLink): MenuAction[] => {
    const open = link.snapshot === null || link.snapshot.state === "open";
    const watching = isWatching(link);
    return [
      { id: "copy", title: gt("Copy link"), image: "link" },
      { id: "browser", title: gt("Open in browser"), image: "safari" },
      ...((watching ? canEdit : canStartWatch) && open
        ? [
            {
              id: "watch",
              title: watching ? gt("Stop watching") : gt("Watch for changes"),
              image: watching ? "eye.slash" : "eye",
            },
          ]
        : []),
      ...(canEdit
        ? [
            {
              id: "unlink",
              title: link.source === "stack" ? gt("Dismiss from thread") : gt("Unlink from thread"),
              image: "xmark",
              attributes: { destructive: true },
            },
          ]
        : []),
    ];
  };

  const onMenuAction = (link: ThreadPullRequestLink, action: string) => {
    if (action === "copy") void Clipboard.setStringAsync(link.url);
    else if (action === "browser")
      void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
        if (!opened) {
          const term = changeRequestTermKind(
            (
              sourceControlClients.findByChangeRequestUrl(link.url) ??
              sourceControlClients.get(undefined)
            ).changeRequest,
          );
          Dialog.alert(
            gt(
              "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
              { term },
            ),
            gt(
              "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
              { term },
            ),
          );
        }
      });
    else if (action === "watch" && canEdit && thread !== null) {
      const title = gt("Couldn't change watching");
      run(title, solus.threadList.setWatching(thread.environmentId, thread.id, {
        repository: `${link.host}/${link.repository}`, number: link.number,
      }, !isWatching(link)).then(outcome => {
        const message = watchRefusalMessage(outcome);
        if (message) Dialog.alert(title, message);
      }));
    }
    else if (action === "unlink") setLinked(link, false);
  };

  return { canLink: canEdit, terminology, promptLink, menuActions, onMenuAction, isWatching };
}

export type LinkedPullRequestActions = ReturnType<typeof useLinkedPullRequestActions>;
