import type { Codebase, CodebaseMember, CodebaseRoot } from "@solus/contracts/codebases";
import type {
  Codebases,
  CodebaseHostMembers,
  CodebaseHostStatus,
} from "@solus-mobile/features/codebases/codebases";
import type {
  ProjectTrackedFolder,
  WorkspaceFolderState,
  WorkspaceScannedFolder,
} from "@t3tools/contracts";

/**
 * The translation from a Solus codebase to the rows of T3's repositories
 * section (docs/plans/codebases.md §10). A Solus project is one folder on one
 * host; the folder list that the section shows is the members of one codebase
 * on one host. Pure: `codebase-folders.ts` binds it to the model.
 */

/** One row of T3's repositories section. `state` is absent until the host reads its disk. */
export type CodebaseFolderRow = ProjectTrackedFolder & { readonly state?: WorkspaceFolderState };

/** T3 limits the name of a folder. */
const FOLDER_NAME_MAX = 128;

function folderName(name: string, path: string): string {
  return name.slice(0, FOLDER_NAME_MAX).trim() || path;
}

function rootRow(root: CodebaseRoot, member: CodebaseMember | null): CodebaseFolderRow {
  const row = { path: root.path, name: folderName(root.name, root.path) };
  return member ? { ...row, state: member.state } : row;
}

/**
 * The folders of one codebase on one host as T3 folder rows: each root that a
 * person added, then the repositories that the host found inside it. A found
 * row has `discovered`, so the section gives it no Remove button.
 */
export function codebaseFolderRows(host: CodebaseHostMembers | undefined): CodebaseFolderRow[] {
  if (!host) return [];
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

/** The roots of a codebase on a host that is not the host of the project. */
export interface CodebaseOtherHost {
  readonly installationId: string;
  /** This phone's id for the host. Null when this phone does not know the host. */
  readonly hostId: string | null;
  /** Null when this phone does not know the host. */
  readonly label: string | null;
  /** `ready`: the section can change the roots. Each other value is read-only. */
  readonly presence: CodebaseHostMembers["presence"];
  /** The states are the last answer of the host, not a current one. */
  readonly isStale: boolean;
  readonly folders: CodebaseFolderRow[];
}

/** One codebase that holds the folder of a project. */
export interface ProjectCodebaseSection {
  readonly codebase: Codebase;
  /** The members on the host of the project. */
  readonly folders: CodebaseFolderRow[];
  /** The roots on each other host, in the order of the roots. A host that this phone does not know stays in the list. */
  readonly otherHosts: CodebaseOtherHost[];
}

export interface ProjectCodebases {
  /** The read of the codebases of the project's host. Null while the host is away. */
  readonly status: CodebaseHostStatus | null;
  /** One section for each codebase that holds the folder of the project. Empty for a project in no codebase. */
  readonly sections: ProjectCodebaseSection[];
}

/** The data of the project overview: the codebases that hold the folder of a project on its host. */
export function projectCodebases(
  codebases: Pick<Codebases, "hosts" | "codebasesOfFolder" | "membersOf">,
  hostId: string,
  path: string,
): ProjectCodebases {
  return {
    status: codebases.hosts().find((host) => host.hostId === hostId)?.status ?? null,
    sections: codebases.codebasesOfFolder(hostId, path).map((codebase) => {
      const hosts = codebases.membersOf(codebase.id);
      const projectHost = hosts.find((host) => host.hostId === hostId);
      return {
        codebase,
        folders: codebaseFolderRows(projectHost),
        otherHosts: hosts
          .filter((host) => host !== projectHost)
          .map((host) => ({
            installationId: host.installationId,
            hostId: host.hostId,
            label: host.label,
            presence: host.presence,
            isStale: host.isStale,
            folders: codebaseFolderRows(host),
          })),
      };
    }),
  };
}
