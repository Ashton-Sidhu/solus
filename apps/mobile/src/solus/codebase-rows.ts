import type { Codebase, CodebaseMember, CodebaseRoot } from "@solus/contracts/codebases";
import type { Codebases, CodebaseHostMembers } from "@solus-mobile/features/codebases/codebases";
import type {
  ProjectTrackedFolder,
  WorkspaceFolderState,
  WorkspaceScannedFolder,
} from "@t3tools/contracts";

/**
 * The translation from a Solus codebase to the rows of T3's repositories
 * section (docs/plans/codebases.md §10). A Solus project is one folder on one
 * host; the folder list that the section shows is the folders of one
 * codebase. Pure: `codebase-folders.ts` binds it to the model.
 */

/**
 * One row of T3's repositories section. `state` is absent until the host
 * reads its disk. `otherHost` is set for a folder on a host that is not the
 * host of the section: the row names that host in place of the path. Its
 * `label` is null for a host that this phone does not know.
 */
export type CodebaseFolderRow = ProjectTrackedFolder & {
  readonly state?: WorkspaceFolderState;
  readonly otherHost?: { readonly installationId: string; readonly label: string | null };
};

/** T3 limits the name of a folder. */
const FOLDER_NAME_MAX = 128;

function folderName(name: string, path: string): string {
  return name.slice(0, FOLDER_NAME_MAX).trim() || path;
}

function rootRow(root: CodebaseRoot, member: CodebaseMember | null): CodebaseFolderRow {
  const row = { path: root.path, name: folderName(root.name, root.path) };
  return member ? { ...row, state: member.state } : row;
}

/** The folders on one host: each root that a person added, then the repositories that the host found inside it. */
function hostFolderRows(host: CodebaseHostMembers): CodebaseFolderRow[] {
  return host.roots.flatMap(({ root, member, found }) => [
    rootRow(root, member),
    ...found.map((repository) => ({
      path: repository.path,
      name: folderName(repository.name, repository.path),
      state: repository.state,
      discovered: true,
    })),
  ]);
}

/** The key of a row: two hosts can have a folder at the same path. */
export function codebaseFolderRowKey(row: CodebaseFolderRow): string {
  return `${row.otherHost?.installationId ?? ""}\n${row.path}`;
}

/**
 * The folders of one codebase as the rows of one section: the folders on the
 * host `hostId` first, then the folders on each other host, in the order of
 * the roots. A found row has `discovered`, so the section gives it no Remove
 * button. A host that is away, or that this phone does not know, keeps its
 * rows.
 */
export function codebaseFolderRows(
  hosts: readonly CodebaseHostMembers[],
  hostId: string,
): CodebaseFolderRow[] {
  const own = hosts.find((host) => host.hostId === hostId);
  return [
    ...(own ? hostFolderRows(own) : []),
    ...hosts
      .filter((host) => host !== own)
      .flatMap((host) =>
        hostFolderRows(host).map((row) => ({
          ...row,
          otherHost: { installationId: host.installationId, label: host.label },
        })),
      ),
  ];
}

/**
 * The members of one codebase on one host, as the host read them from its
 * disk: each root, then the repositories found in it. Null until the host
 * gives an answer, so a reader does not take "not read" for "no member".
 */
export function codebaseMembersOf(host: CodebaseHostMembers | undefined): CodebaseMember[] | null {
  if (!host || (host.state !== "ready" && !host.isStale)) return null;
  return host.roots.flatMap(({ member, found }) => [...(member ? [member] : []), ...found]);
}

/**
 * T3's scan answer for the section: the folders that the `.code-workspace`
 * files of the roots list. The section offers each one with an Add button and
 * never adds one by itself.
 */
export function codebaseScannedFolders(
  host: CodebaseHostMembers | undefined,
): WorkspaceScannedFolder[] {
  if (!host) return [];
  const seen = new Set<string>();
  return host.roots.flatMap(({ suggestions }) =>
    suggestions.flatMap((suggestion) => {
      if (seen.has(suggestion.path)) return [];
      seen.add(suggestion.path);
      return [
        {
          path: suggestion.path,
          name: folderName(suggestion.name, suggestion.path),
          // The host does not say what a listed folder holds until it is a root.
          isGitRepository: false,
          source: "code-workspace" as const,
        },
      ];
    }),
  );
}

/** One checkout of the project that a page shows: its folder on its host. */
export interface ProjectCheckout {
  readonly hostId: string;
  readonly path: string;
}

/** What the project page shows of codebases for the checkouts of one project. */
export interface ProjectPageCodebases {
  /**
   * One section for each codebase that holds a checkout, by name. `hostId` is
   * the host of the first checkout that the codebase holds: the section lists
   * the folders on that host first.
   */
  readonly sections: readonly { readonly codebase: Codebase; readonly hostId: string }[];
  /** The checkouts that no codebase holds, on a host whose codebases are read: each can make a codebase. */
  readonly loose: readonly (ProjectCheckout & { readonly hostLabel: string })[];
  /** The hosts that this phone can do work on now: a folder can be added on each. */
  readonly readyHosts: readonly { readonly hostId: string; readonly label: string }[];
}

export function projectPageCodebases(
  codebases: Pick<Codebases, "hosts" | "codebasesOfFolder">,
  checkouts: readonly ProjectCheckout[],
): ProjectPageCodebases {
  const sections = new Map<string, { codebase: Codebase; hostId: string }>();
  const loose: (ProjectCheckout & { hostLabel: string })[] = [];
  const hosts = codebases.hosts();
  for (const checkout of checkouts) {
    const holding = codebases.codebasesOfFolder(checkout.hostId, checkout.path);
    for (const codebase of holding) {
      if (!sections.has(codebase.id)) sections.set(codebase.id, { codebase, hostId: checkout.hostId });
    }
    const host = hosts.find((entry) => entry.hostId === checkout.hostId);
    // A list that is not read does not show that the checkout is in no codebase.
    if (holding.length === 0 && host?.status === "ready") {
      loose.push({ ...checkout, hostLabel: host.label });
    }
  }
  return {
    sections: [...sections.values()].sort(
      (a, b) =>
        a.codebase.name.localeCompare(b.codebase.name) || a.codebase.id.localeCompare(b.codebase.id),
    ),
    loose,
    readyHosts: hosts
      .filter((host) => host.isReady)
      .map((host) => ({ hostId: host.hostId, label: host.label })),
  };
}
