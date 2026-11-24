import type {
  Codebase,
  CodebaseFolderScan,
  CodebaseFolderSuggestion,
  CodebaseMember,
  CodebaseMemberState,
} from "@solus/contracts/codebases";
import {
  Codebases,
  type CodebaseHostConnection,
  type CodebaseMachine,
} from "@solus-mobile/features/codebases/codebases";

/** What one folder on a fake host's disk holds. */
interface DiskFolder {
  readonly state: CodebaseMemberState;
  /** The repositories inside the folder, as paths. */
  readonly found?: readonly string[];
  readonly suggestions?: readonly CodebaseFolderSuggestion[];
}

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

function member(path: string, rootPath: string, state: CodebaseMemberState): CodebaseMember {
  return {
    path,
    name: baseName(path),
    state,
    repositoryKey: null,
    rootPath,
    discovered: path !== rootPath,
    hasCommit: state === "git",
    submodule: false,
  };
}

/** A host that keeps codebases as a Solus host does: the newer `updatedAt` wins, and members come from its disk. */
export class FakeHost {
  readonly copies = new Map<string, Codebase>();
  readonly saves: Codebase[] = [];
  readonly disk = new Map<string, DiskFolder>();
  /** A path that the host resolves to a different one, for example `~/shop`. */
  readonly resolved = new Map<string, string>();
  listReads = 0;
  memberReads = 0;
  saveError: string | null = null;
  isReady = true;
  generation = 1;
  private readonly changedListeners = new Set<() => void>();

  readonly connection: CodebaseHostConnection = {
    api: {
      codebaseList: async () => {
        this.listReads += 1;
        return [...this.copies.values()];
      },
      codebaseSave: async (copy) => {
        if (this.saveError) throw new Error(this.saveError);
        this.saves.push(copy);
        const kept = this.copies.get(copy.id);
        if (!kept || copy.updatedAt > kept.updatedAt) this.copies.set(copy.id, copy);
        return this.copies.get(copy.id)!;
      },
      codebaseMembers: async (codebaseId) => {
        this.memberReads += 1;
        const codebase = this.copies.get(codebaseId);
        if (!codebase) throw new Error("This host has no copy of the codebase.");
        return codebase.roots
          .filter((root) => root.installationId === this.installationId)
          .flatMap((root) => {
            const folder = this.disk.get(root.path);
            return [
              member(root.path, root.path, folder?.state ?? "missing"),
              ...(folder?.found ?? []).map((path) => member(path, root.path, "git")),
            ];
          });
      },
      codebaseScanFolder: async (path) => this.scan(path),
    },
    events: {
      subscribe: (type, listener) => {
        if (type !== "codebases.changed") return () => {};
        // SAFETY: the type is `codebases.changed` here, and a listener of that event reads no payload.
        const changed = () => (listener as () => void)();
        this.changedListeners.add(changed);
        return () => {
          this.changedListeners.delete(changed);
        };
      },
    },
  };

  constructor(
    readonly hostId: string,
    readonly installationId = hostId,
  ) {}

  /** A different client changed a codebase on this host. */
  announceChange(): void {
    for (const listener of this.changedListeners) listener();
  }

  machine(): CodebaseMachine {
    return {
      hostId: this.hostId,
      installationId: this.installationId,
      label: `Host ${this.hostId}`,
      connection: this.isReady ? this.connection : null,
      generation: this.generation,
    };
  }

  private scan(asked: string): CodebaseFolderScan {
    const path = this.resolved.get(asked) ?? asked;
    const folder = this.disk.get(path);
    return {
      path,
      state: folder?.state ?? "missing",
      members: (folder?.found ?? []).map((found) => member(found, path, "git")),
      suggestions: [...(folder?.suggestions ?? [])],
    };
  }
}

/** A phone with fake hosts, one account scope, and a clock that the test sets. */
export class FakePhone {
  scope = "account organization";
  now = 1_000;
  hosts: FakeHost[];
  private readonly listeners = new Set<() => void>();
  private ids = 0;
  readonly codebases: Codebases;

  constructor(...hosts: FakeHost[]) {
    this.hosts = hosts;
    this.codebases = new Codebases({
      scope: () => this.scope,
      machines: () => this.hosts.map((host) => host.machine()),
      onChange: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      uuid: () => `codebase-${++this.ids}`,
      now: () => this.now,
    });
  }

  /** A host, a connection, or the account changed. */
  async changed(): Promise<void> {
    for (const listener of this.listeners) listener();
    await settle();
  }
}

/** Let every answer of the fake hosts arrive. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A folder on a host that no test connects: the second folder of a codebase, which has two or more. */
export const ELSEWHERE: Codebase["roots"][number] = {
  installationId: "installation-elsewhere",
  path: "/srv/elsewhere",
  name: "elsewhere",
};

/** The roots of a codebase whose folders a test does not read. */
const TWO_ROOTS: Codebase["roots"] = [
  { installationId: "installation-elsewhere", path: "/srv/one", name: "one" },
  { installationId: "installation-elsewhere", path: "/srv/two", name: "two" },
];

export function codebase(
  id: string,
  updatedAt: number,
  roots: Codebase["roots"] = TWO_ROOTS,
  deletedAt: number | null = null,
): Codebase {
  return { id, name: id, roots, updatedAt, deletedAt };
}
