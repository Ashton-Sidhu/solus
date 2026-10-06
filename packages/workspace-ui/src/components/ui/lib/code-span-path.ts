/*
 * A code span that names a file renders as a chip. The chip has room for the
 * last two segments only, so the parts it drops are rendered copy-only: a
 * selection copied out of a message then carries the whole path the author
 * wrote, not the two segments that happened to fit.
 */

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** The one directory the chip shows, with its slash. Empty for a bare name. */
export function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return `${parts[parts.length - 2]}/`;
}

/** Everything ahead of what the chip shows. Empty when the chip shows it all. */
export function leadingDirs(path: string): string {
  return path.slice(0, path.length - (parentDir(path) + basename(path)).length);
}

/*
 * Which code spans name a file. Adapted from T3 Code's
 * `inlineCodeFilePathCandidate` (packages/client-runtime/src/markdownLinks.ts,
 * MIT); the mobile app runs the same rule from its own copy in
 * apps/mobile/modules/t3-markdown-text/src/markdownLinkTargets.ts, so keep the
 * two in step.
 *
 * A code span mostly holds identifiers, commands, and refs (`node.meta`,
 * `origin/main`, `port:3000`, `/api/sessions`), so it becomes a chip only on
 * strong evidence: a path prefix, a file extension, a known file name, or a
 * `:line` suffix. The checks are T3's inline-code candidate rule followed by
 * the file test its link resolver applies to that candidate. Two deliberate
 * differences from mobile: a known extensionless name in a folder
 * (`docker/Dockerfile`) is a file, and a folder may hold any character
 * (`app/[id]/page.tsx`).
 */

const RELATIVE_PATH_PREFIX_RE = /^(~\/|\.{1,2}\/)/;
const WINDOWS_ABSOLUTE_PATH_RE = /^(?:\\\\|[a-zA-Z]:(?:[/\\]|$))/;
const POSITION_SUFFIX_RE = /:(\d+)(?::\d+)?$/;
const DISQUALIFIER_RE = /[\s`]/;
const PATH_SEPARATOR_RE = /[\\/]/;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9_-]+$/;
// A final dot between digits marks a version or model id (`glm-5.3`,
// `Qwen2.5-Coder`), not an extension. `ls.1` and `libfoo.so.1` stay files.
const VERSION_SUFFIX_RE = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)+$/;
// Standard OS and dev-container roots; app routes such as /api/ or /chat/ are
// left out so a route in prose never reads as a file.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/", "/home/", "/tmp/", "/var/", "/etc/", "/opt/", "/mnt/", "/Volumes/",
  "/private/", "/root/", "/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/srv/",
  "/dev/", "/proc/", "/sys/", "/run/", "/boot/", "/media/", "/workspace/",
  "/workspaces/",
];
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile",
  "Justfile", "justfile", "Rakefile", "Gemfile", "Procfile", "Brewfile",
  "Caddyfile", "Vagrantfile", "Jenkinsfile", "Podfile", "Fastfile", "BUILD",
  "WORKSPACE", "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS",
  "CONTRIBUTORS", "CHANGELOG", "README", "CODEOWNERS",
]);
// Allowlists, so a dotted folder (`conf.d/`) or file (`Makefile.in:12`) is not
// read as a host.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com", "net", "org", "io", "dev", "app", "ai", "co", "edu", "gov", "mil",
  "info", "biz", "xyz", "me", "tv", "cc", "gg", "chat", "cloud", "site",
  "online", "tech", "store", "link",
]);
// Country codes also name file extensions; a `:line` suffix makes a `.pl` or
// `.pt` file more likely than a host.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk", "de", "fr", "nl", "se", "no", "fi", "dk", "pl", "ch", "at", "be", "es",
  "it", "pt", "eu", "us", "ca", "au", "nz", "jp", "kr", "cn", "br", "ru", "mx",
  "ie", "cz", "tr", "sg", "hk",
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (lowered === "localhost" || NUMERIC_DOTTED_RE.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

export interface CodeSpanFileTarget {
  path: string;
  line?: number;
}

/** The file (and line) a code span names, or null when it is not a path. */
export function codeSpanFileTarget(codeText: string): CodeSpanFileTarget | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || DISQUALIFIER_RE.test(trimmed)) return null;

  const isWindowsAbsolute = WINDOWS_ABSOLUTE_PATH_RE.test(trimmed);
  const candidate = isWindowsAbsolute ? trimmed : trimmed.replaceAll("\\", "/");
  const position = candidate.match(POSITION_SUFFIX_RE);
  if (!position && !PATH_SEPARATOR_RE.test(candidate)) return null;

  const path = position ? candidate.slice(0, position.index) : candidate;
  const name = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const namesFile = FILE_EXTENSION_RE.test(name) || EXTENSIONLESS_FILE_NAMES.has(name);

  if (isWindowsAbsolute || RELATIVE_PATH_PREFIX_RE.test(candidate)) {
    // An explicit path prefix is evidence enough.
  } else if (candidate.startsWith("/")) {
    const isFilesystemRoot = POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!isFilesystemRoot && !position && !namesFile) return null;
  } else {
    if (looksLikeHostname(path.split("/")[0] ?? path, !!position)) return null;
    if (VERSION_SUFFIX_RE.test(name)) return null;
    // A folder with a `:line` may name an extensionless file; a bare name may not.
    if (!namesFile && !(position && path.includes("/"))) return null;
  }
  return position ? { path, line: Number(position[1]) } : { path };
}
