import { findExistingAddProject } from "@t3tools/client-runtime/operations/projects";
import type {
  EnvironmentId,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import { hostQuery } from "./host-query";
import { getSolusDirectory, solus } from "./runtime";

function projectApi(hostId: string) {
  const host = solus.connections.connection(hostId);
  if (!host || !solus.connections.may(hostId, "host.use"))
    throw new Error("The project host is unavailable.");
  return host.api;
}

const readiness = hostQuery((id, _input: null) => {
  const host = solus.connections.connection(id);
  if (!host) throw new Error("The project host is unavailable.");
  return host.api.setupHostReadiness();
});
const readinessByHost = Atom.family((key: string) =>
  Atom.make((get) => {
    const ids: EnvironmentId[] = JSON.parse(key);
    return new Map(
      ids.map((id) => [
        id,
        AsyncResult.getOrElse(get(readiness({ environmentId: id, input: null })), () => null),
      ]),
    );
  }),
);
export function useProjectHosts(ids: readonly EnvironmentId[]) {
  return useAtomValue(readinessByHost(JSON.stringify(ids)));
}

export const browseProjectFolders = hostQuery(
  async (
    id,
    input: Pick<FilesystemBrowseInput, "partialPath">,
  ): Promise<FilesystemBrowseResult> => {
    if (!solus.connections.may(id, "host.files.read"))
      throw new Error("This connection cannot browse host folders.");
    const result = await projectApi(id).listDirectory(input.partialPath, true);
    if (result.error) throw new Error(result.error);
    return {
      parentPath: result.currentPath,
      entries: result.entries
        .filter((entry) => entry.isDir)
        .map((entry) => ({ name: entry.name, fullPath: entry.path })),
    };
  },
  0,
  5_000,
);

export async function addLocalProject(environmentId: EnvironmentId, path: string) {
  const api = projectApi(environmentId);
  const directory = await api.listDirectory(path);
  if (directory.error) throw new Error(directory.error);
  const lookup = () =>
    findExistingAddProject({
      projects: getSolusDirectory().projects,
      environmentId,
      path: directory.currentPath,
    });
  const existing = lookup();
  if (existing) return existing;
  await api.trackRecentProject(directory.currentPath);
  await solus.threads.load(environmentId);
  return lookup();
}

/** Add a folder on a host to a codebase. The host scans it, and the resolved path is the new root. */
export async function addCodebaseFolder(
  environmentId: EnvironmentId,
  codebaseId: string,
  path: string,
) {
  if (!solus.connections.may(environmentId, "host.use"))
    throw new Error("This connection cannot change codebases on this host.");
  await solus.codebases.addRoot(codebaseId, { hostId: environmentId, path });
}

/**
 * Make a codebase of two folders on one host: the folder of a project and a
 * second folder that the person chose. A codebase has two or more folders
 * (docs/plans/codebases.md decision 14).
 */
export async function makeCodebase(
  environmentId: EnvironmentId,
  name: string,
  folders: readonly [string, string],
) {
  if (!solus.connections.may(environmentId, "host.use"))
    throw new Error("This connection cannot change codebases on this host.");
  await solus.codebases.create(
    name,
    folders.map((path) => ({ hostId: environmentId, path })),
  );
}

export async function cloneProject(environmentId: EnvironmentId, cloneUrl: string, path: string) {
  const api = projectApi(environmentId);
  const existing = findExistingAddProject({
    projects: getSolusDirectory().projects,
    environmentId,
    path,
  });
  const project = existing
    ? await api.setupAdoptProject({ cloneUrl, path: existing.workspaceRoot })
    : await api.setupCloneProject({ cloneUrl, destination: path });
  await solus.threads.load(environmentId);
  return project;
}

export async function createProject(environmentId: EnvironmentId, name: string, publish: boolean) {
  const api = projectApi(environmentId);
  const organizationId = solus.account.organizationId;
  const project = await api.setupCreateProject({ name });
  let publishError: Error | null = null;
  if (publish) {
    try {
      const result = await api.githubPublishRepository(
        projectContext(project.path, organizationId),
        { name, private: true, protocol: "https" },
      );
      for (const step of [result.repository, result.remote, result.push]) {
        if (step.status === "failed") throw new Error(step.error);
      }
    } catch (cause) {
      publishError = cause instanceof Error ? cause : new Error(String(cause));
    }
  }
  await solus.threads.load(environmentId);
  return { project, publishError };
}
