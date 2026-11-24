import { keepEqual } from "@solus/client-core/keep-equal";
import type { CodebaseHostMembers } from "@solus-mobile/features/codebases/codebases";
import type { Codebase } from "@solus/contracts/codebases";
import type { EnvironmentId, ProjectTrackedFolder } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  codebaseFolderRows,
  codebaseMembersOf,
  codebaseScannedFolders,
  projectPageCodebases,
  type CodebaseFolderRow,
  type ProjectCheckout,
  type ProjectPageCodebases,
} from "./codebase-rows";
import { hostCommand } from "./host-command";
import { solus } from "./runtime";

/**
 * The folder list of T3's repositories section, from the codebases model
 * (docs/plans/codebases.md §10). The model owns each read: these atoms give
 * its answer for one codebase, as one host of the phone sees it, in the shape
 * that the T3 queries give. They are the demand that makes the model read the
 * members. The app reads the codebases themselves from its start
 * (`startSolus`).
 */

interface CodebaseHostTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly codebaseId: string };
}

function onHost(
  hosts: readonly CodebaseHostMembers[],
  hostId: string,
): CodebaseHostMembers | undefined {
  return hosts.find((host) => host.hostId === hostId);
}

function hostAnswer<A>(select: (hosts: readonly CodebaseHostMembers[], hostId: string) => A) {
  const family = Atom.family((key: string) => {
    const [hostId, codebaseId]: [string, string] = JSON.parse(key);
    const read = () => {
      const hosts = solus.codebases.membersOf(codebaseId);
      return { value: select(hosts, hostId), waiting: onHost(hosts, hostId)?.state === "loading" };
    };
    return Atom.readable(
      (get) => {
        let shown = read();
        let isDisposed = false;
        let stop: (() => void) | undefined;
        // The model tells its listeners when a read starts. That must not occur during this read.
        queueMicrotask(() => {
          if (!isDisposed) stop = solus.codebases.watchMembers(codebaseId);
        });
        get.addFinalizer(() => {
          isDisposed = true;
          stop?.();
        });
        get.addFinalizer(
          solus.codebases.changes.subscribe(() => {
            const next = read();
            const value = keepEqual(next.value, shown.value);
            if (value === shown.value && next.waiting === shown.waiting) return;
            shown = { value, waiting: next.waiting };
            get.setSelf(AsyncResult.success<A, Error>(value, { waiting: next.waiting }));
          }),
        );
        return AsyncResult.success<A, Error>(shown.value, { waiting: shown.waiting });
      },
      () => void solus.codebases.refreshMembers(codebaseId),
    );
  });
  return (target: CodebaseHostTarget) =>
    family(JSON.stringify([target.environmentId, target.input.codebaseId]));
}

function installationIdOf(hostId: string): string {
  const host = solus.codebases.hosts().find((entry) => entry.hostId === hostId);
  if (!host?.isReady) throw new Error("This host is not ready. Wait until it is connected, then try again.");
  return host.installationId;
}

export const codebaseFolders = {
  /** T3's `listFolders` for one codebase: the folders on the host, then the folders on each other host, with what is on each disk now. */
  listFolders: hostAnswer((hosts, hostId) => ({ folders: codebaseFolderRows(hosts, hostId) })),
  /** The members of one codebase on one host with what the host says of each: a repository with no commit and a submodule cannot get a worktree. Null until the host answers. */
  members: hostAnswer((hosts, hostId) => codebaseMembersOf(onHost(hosts, hostId))),
  /** T3's `scanFolders` for the roots on the host: the folders that their `.code-workspace` files list. */
  scanFolders: hostAnswer((hosts, hostId) => ({
    folders: codebaseScannedFolders(onHost(hosts, hostId)),
  })),
  /** T3's project update for the folder list: one root of the codebase in or out. The host scans a new root. A root on a different host leaves by the installation id of its row. */
  update: hostCommand(
    "codebases.folders.update",
    "host.use",
    async (
      environmentId,
      input: {
        readonly codebaseId: string;
        readonly trackFolders?: readonly Pick<ProjectTrackedFolder, "path" | "name">[];
        readonly untrackFolders?: readonly Pick<CodebaseFolderRow, "path" | "otherHost">[];
      },
    ) => {
      for (const folder of input.trackFolders ?? []) {
        await solus.codebases.addRoot(input.codebaseId, { hostId: environmentId, path: folder.path });
      }
      for (const folder of input.untrackFolders ?? []) {
        await solus.codebases.removeRoot(input.codebaseId, {
          installationId: folder.otherHost?.installationId ?? installationIdOf(environmentId),
          path: folder.path,
        });
      }
    },
  ),
};

/**
 * One read of the model whose answer a screen reads as a store snapshot: the
 * same object comes back until the answer changes.
 */
function shownAnswers<A>() {
  const held = new Map<string, { revision: number; value: A }>();
  return (key: string, read: () => A): A => {
    const last = held.get(key);
    const revision = solus.codebases.revision;
    if (last?.revision === revision) return last.value;
    const next = read();
    const value = last ? keepEqual(next, last.value) : next;
    held.set(key, { revision, value });
    return value;
  };
}

const folderCodebases = shownAnswers<readonly Codebase[]>();
const pageCodebases = shownAnswers<ProjectPageCodebases>();

/** The codebases that hold a folder on a host of this phone, by name: the folder is a root, or it is inside a root. */
export function readFolderCodebases(hostId: string, path: string): readonly Codebase[] {
  return folderCodebases(JSON.stringify([hostId, path]), () =>
    solus.codebases.codebasesOfFolder(hostId, path),
  );
}

/** What the project page shows of codebases for the checkouts of one project. */
export function readProjectPageCodebases(
  checkouts: readonly ProjectCheckout[],
): ProjectPageCodebases {
  return pageCodebases(
    JSON.stringify(checkouts.map((checkout) => [checkout.hostId, checkout.path])),
    () => projectPageCodebases(solus.codebases, checkouts),
  );
}
