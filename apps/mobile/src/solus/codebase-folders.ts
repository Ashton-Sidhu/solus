import { keepEqual } from "@solus/client-core/keep-equal";
import type { CodebaseHostMembers } from "@solus-mobile/features/codebases/codebases";
import type { EnvironmentId, ProjectTrackedFolder } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  codebaseFolderRows,
  codebaseMembersOf,
  codebaseScannedFolders,
  projectCodebases,
  type ProjectCodebases,
} from "./codebase-rows";
import { hostCommand } from "./host-command";
import { solus } from "./runtime";

/**
 * The folder list of T3's repositories section, from the codebases model
 * (docs/plans/codebases.md §10). The model owns each read: these atoms give
 * its answer for one codebase on one host in the shape that the T3 queries
 * give, and they are the demand that makes the model read.
 */

interface CodebaseHostTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly codebaseId: string };
}

function hostAnswer<A>(select: (host: CodebaseHostMembers | undefined) => A) {
  const family = Atom.family((key: string) => {
    const [hostId, codebaseId]: [string, string] = JSON.parse(key);
    const read = () => {
      const host = solus.codebases
        .membersOf(codebaseId)
        .find((entry) => entry.hostId === hostId);
      return { value: select(host), waiting: host?.state === "loading" };
    };
    return Atom.readable(
      (get) => {
        let shown = read();
        let isDisposed = false;
        let stops: (() => void)[] = [];
        // The model tells its listeners when a read starts. That must not occur during this read.
        queueMicrotask(() => {
          if (isDisposed) return;
          stops = [solus.codebases.watch(), solus.codebases.watchMembers(codebaseId)];
        });
        get.addFinalizer(() => {
          isDisposed = true;
          for (const stop of stops) stop();
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
  /** T3's `listFolders` for one codebase on one host: each root, then the repositories found in it, with what is on the disk now. */
  listFolders: hostAnswer((host) => ({ folders: codebaseFolderRows(host) })),
  /** The members of one codebase on one host with what the host says of each: a repository with no commit and a submodule cannot get a worktree. Null until the host answers. */
  members: hostAnswer(codebaseMembersOf),
  /** T3's `scanFolders` for the same roots: the folders that their `.code-workspace` files list. */
  scanFolders: hostAnswer((host) => ({ folders: codebaseScannedFolders(host) })),
  /** T3's project update for the folder list: one root of the codebase in or out on this host. The host scans a new root. */
  update: hostCommand(
    "codebases.folders.update",
    "host.use",
    async (
      environmentId,
      input: {
        readonly codebaseId: string;
        readonly trackFolders?: readonly Pick<ProjectTrackedFolder, "path" | "name">[];
        readonly untrackFolders?: readonly string[];
      },
    ) => {
      for (const folder of input.trackFolders ?? []) {
        await solus.codebases.addRoot(input.codebaseId, { hostId: environmentId, path: folder.path });
      }
      for (const path of input.untrackFolders ?? []) {
        await solus.codebases.removeRoot(input.codebaseId, {
          installationId: installationIdOf(environmentId),
          path,
        });
      }
    },
  ),
};

const shownProjectCodebases = new Map<string, { revision: number; value: ProjectCodebases }>();

/**
 * The codebases that hold the folder of a project on its host, for the project
 * overview. The same object comes back until the answer changes, so a screen
 * can read it as a store snapshot.
 */
export function readProjectCodebases(hostId: string, path: string): ProjectCodebases {
  const key = JSON.stringify([hostId, path]);
  const shown = shownProjectCodebases.get(key);
  const revision = solus.codebases.revision;
  if (shown?.revision === revision) return shown.value;
  const next = projectCodebases(solus.codebases, hostId, path);
  const value = shown ? keepEqual(next, shown.value) : next;
  shownProjectCodebases.set(key, { revision, value });
  return value;
}
