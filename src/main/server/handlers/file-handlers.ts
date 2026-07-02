import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { join, basename, extname, dirname, resolve as pathResolve, relative as pathRelative } from 'path'
import { existsSync, writeFileSync, readFileSync, statSync } from 'fs'
import { appendFile, mkdir, open, readFile as readBinaryFile, readdir, realpath, stat, writeFile as writeTextFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { execFile, execFileSync } from 'child_process'
import type { AgentId, Attachment, IpcContext, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectFilesRequest, ProjectFilesResult, WriteFileRequest, WriteFileResult, FileMatch, DetectedEditor, DetectedTerminal, EditorId } from '../../../shared/types'
import { AGENT_BIN } from '../../../shared/types'
import { transcribeAudio } from '../../transcription'
import { launchInTerminal } from '../../terminal-launcher'
import { getCliEnv } from '../../cli-env'
import { createLogger } from '../../logger'
import { getFinder, refreshFinder } from '../file-finder'
import type { SolusServer } from '../server'

const log = createLogger('main', 'file-handlers')

export interface FileDeps {
  /** The focused Solus window, falling back to the last-focused live one —
   *  dialogs, screenshots, and design mode target the window the user is in. */
  getActiveWindow(): BrowserWindow | null
  hideAppWindow(): void
  /** Used by takeScreenshot to restore + focus the window after capturing. */
  showAndFocusActiveWindow(): void
  /** Used by enterDesignMode to make the window invisible to screen capture. */
  setActiveWindowOpacity(opacity: number): void
  /** Restores the window after design mode (opacity, alwaysOnTop, visibility, focus). */
  restoreDesignModeWindow(): void
  bumpScreenshotCounter(): number
  bumpDesignModeCounter(): number
  bumpPasteCounter(): number
  /** Returns the work-area rect of the cursor's display, used as design-mode capture region. */
  designModeCaptureRegion(): { x: number; y: number; width: number; height: number }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
}
const PROJECT_FILES_MAX_ENTRIES = 25_000
const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)
const VOICE_TRANSCRIPTIONS_CSV = join(homedir(), '.solus', 'voice-transcriptions.csv')
const VOICE_TRANSCRIPTIONS_CSV_HEADER = [
  'session_index',
  'first_started_at',
  'started_at',
  'listening_ms',
  'transcribe_ms',
  'prompt',
  'prompt_chars',
  'prompt_words',
  'total_listening_ms',
  'success',
].join(',') + '\n'

type VoiceTranscriptionCsvRow = {
  sessionIndex: number
  firstStartedAt: string | null
  startedAt: string | null
  listeningMs: number | null
  transcribeMs: number
  prompt: string
  promptChars: number
  promptWords: number
  totalListeningMs: number
  success: boolean
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function filePathsToAttachments(filePaths: string[]): Attachment[] {
  return filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = MIME_MAP[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
}

function writeDataUrlToTmp(dataUrl: string, namePrefix: string): { mimeType: string; ext: string; buf: Buffer; filePath: string } | null {
  const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
  if (!match) return null
  const [, mimeType, ext, base64Data] = match
  const buf = Buffer.from(base64Data, 'base64')
  const filePath = join(tmpdir(), `${namePrefix}-${Date.now()}.${ext}`)
  writeFileSync(filePath, buf)
  return { mimeType, ext, buf, filePath }
}

function runScreencapture(args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', args, { timeout }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildAgentTerminalCommand(agentId: AgentId, agentBin: string, sessionId: string | null, projectPath: string): string {
  if (agentId === 'claude-code') {
    return sessionId ? `${agentBin} --resume ${shellQuote(sessionId)}` : agentBin
  }
  if (agentId === 'codex') {
    return sessionId ? `${agentBin} resume ${shellQuote(sessionId)}` : agentBin
  }
  return sessionId ? `${agentBin} --resume ${shellQuote(sessionId)}` : agentBin
}

function sortDirEntries(entries: { name: string; isDir: boolean }[]) {
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function resolvePreviewPath(rawPath: string, cwd: string | undefined): string {
  if (rawPath.startsWith('~/')) return join(homedir(), rawPath.slice(2))
  if (rawPath === '~') return homedir()
  if (rawPath.startsWith('/')) return pathResolve(rawPath)
  return pathResolve(cwd || process.cwd(), rawPath)
}

function projectRootForRequest(ctx: IpcContext, cwd?: string): string | null {
  const raw =
    cwd ||
    ctx.session.gitContext?.worktreePath ||
    (ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : undefined)
  return raw ? resolvePreviewPath(raw, undefined) : null
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = pathRelative(root, target)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'))
}

function normalizeFinderRelativePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/\/+$/, '')
}

async function listIndexedProjectFiles(root: string): Promise<ProjectFilesResult> {
  const finder = await getFinder(root)
  if (!finder) {
    return { ok: false, root, error: 'Unable to index project files.' }
  }

  const result = finder.mixedSearch('', { pageSize: PROJECT_FILES_MAX_ENTRIES + 2 })
  if (!result.ok) {
    log.warn(`mixedSearch failed while listing project files in ${root}: ${result.error}`)
    return { ok: false, root, error: result.error }
  }

  const files: string[] = []
  for (const entry of result.value.items) {
    if (entry.type !== 'file') continue
    const relativePath = normalizeFinderRelativePath(entry.item.relativePath)
    if (relativePath) {
      files.push(relativePath)
    }
    if (files.length >= PROJECT_FILES_MAX_ENTRIES) {
      break
    }
  }

  files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))

  return {
    ok: true,
    root,
    files,
    truncated: result.value.totalMatched > PROJECT_FILES_MAX_ENTRIES,
    source: 'index',
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sampleLength = Math.min(buf.length, 8000)
  for (let i = 0; i < sampleLength; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function readFilePrefix(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const sample = Buffer.alloc(Math.min(size, 8000))
    const result = await handle.read(sample, 0, sample.length, 0)
    return sample.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

async function readTextFile(
  ctx: IpcContext,
  request: FilePreviewRequest,
  options: { requireProjectRoot?: boolean } = {},
): Promise<FilePreviewResult> {
  const rawRoot = projectRootForRequest(ctx, request.cwd) ?? undefined
  const resolved = resolvePreviewPath(request.path, rawRoot)
  let root: string | undefined
  let target = resolved

  try {
    if (options.requireProjectRoot) {
      if (!rawRoot) {
        return { ok: false, path: request.path, error: 'No project directory is available.' }
      }
      root = await realpath(rawRoot)
      target = await realpath(resolved)
      if (!isInsideRoot(root, target)) {
        return { ok: false, path: target, error: 'File path is outside the project directory.' }
      }
    } else if (rawRoot) {
      try {
        root = await realpath(rawRoot)
      } catch {
        root = rawRoot
      }
    }

    const fileStat = await stat(target)
    if (!fileStat.isFile()) {
      return { ok: false, path: target, error: 'Only files can be previewed.' }
    }
    const sample = await readFilePrefix(target, fileStat.size)
    if (isBinaryBuffer(sample)) {
      return { ok: false, path: target, error: 'Binary files cannot be previewed.' }
    }

    const buf = await readBinaryFile(target)
    const ext = extname(target).toLowerCase()
    const displayPath =
      root && isInsideRoot(root, target)
        ? pathRelative(root, target)
        : target

    return {
      ok: true,
      path: target,
      displayPath,
      contents: buf.toString('utf-8'),
      size: fileStat.size,
      mimeType: MIME_MAP[ext],
    }
  } catch (err: any) {
    return {
      ok: false,
      path: target,
      error: err?.message ?? String(err),
    }
  }
}

export function registerFileHandlers(server: SolusServer, deps: FileDeps): void {
  server.register('selectDirectory', async () => {
    const win = deps.getActiveWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  server.register('saveFileDialog', async (args) => {
    const [defaultName, content] = args as [string, string]
    const win = deps.getActiveWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content, 'utf8')
    return result.filePath
  })

  server.register('openExternal', async (args) => {
    const [url, options] = args as [string, { hideAppAfterOpen?: boolean } | undefined]
    try {
      if (!/^https?:\/\//i.test(url)) return false
      await shell.openExternal(url)
      if (options?.hideAppAfterOpen) deps.hideAppWindow()
      return true
    } catch {
      return false
    }
  })

  server.register('attachFiles', async () => {
    const win = deps.getActiveWindow()
    if (!win) return null
    const options = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
        { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
      ],
    }
    const result = await dialog.showOpenDialog(win, options)
    if (result.canceled || result.filePaths.length === 0) return null
    return filePathsToAttachments(result.filePaths)
  })

  server.register('attachFilePaths', async (args) => {
    const [filePaths] = args as [string[]]
    if (!filePaths || filePaths.length === 0) return null
    return filePathsToAttachments(filePaths)
  })

  server.register('takeScreenshot', async () => {
    const win = deps.getActiveWindow()
    if (!win) return null

    win.hide()
    await new Promise((r) => setTimeout(r, 300))

    try {
      const screenshotPath = join(tmpdir(), `solus-screenshot-${Date.now()}.png`)
      await runScreencapture(['-i', screenshotPath], 30000)

      if (!existsSync(screenshotPath)) return null

      const buf = readFileSync(screenshotPath)
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `screenshot ${deps.bumpScreenshotCounter()}.png`,
        path: screenshotPath,
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
        size: buf.length,
      }
    } catch {
      return null
    } finally {
      deps.showAndFocusActiveWindow()
    }
  })

  server.register('enterDesignMode', async () => {
    const win = deps.getActiveWindow()
    if (!win) return null

    const { x: wx, y: wy, width: ww, height: wh } = deps.designModeCaptureRegion()

    deps.setActiveWindowOpacity(0)
    await new Promise((r) => setTimeout(r, 300))

    try {
      const screenshotPath = join(tmpdir(), `solus-design-${Date.now()}.png`)
      await runScreencapture(['-x', '-R', `${wx},${wy},${ww},${wh}`, screenshotPath], 10000)

      if (!existsSync(screenshotPath)) return null

      const buf = readFileSync(screenshotPath)
      const designIdx = deps.bumpDesignModeCounter()
      return {
        id: crypto.randomUUID(),
        name: `design ${designIdx}.png`,
        path: screenshotPath,
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
        size: buf.length,
      }
    } catch {
      return null
    }
  })

  server.register('designModeReady', () => {
    deps.restoreDesignModeWindow()
  })

  server.register('submitDesignAnnotations', async (args) => {
    const [data] = args as [{ dataUrl: string; annotations: unknown[] }]
    try {
      const saved = writeDataUrlToTmp(data.dataUrl, 'solus-design-annotated')
      if (!saved) return null
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `design annotated.png`,
        path: saved.filePath,
        mimeType: 'image/png',
        dataUrl: data.dataUrl,
        size: saved.buf.length,
      }
    } catch {
      return null
    }
  })

  server.register('pasteImage', async (args) => {
    const [dataUrl] = args as [string]
    try {
      const saved = writeDataUrlToTmp(dataUrl, 'solus-paste')
      if (!saved) return null
      const idx = deps.bumpPasteCounter()
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `pasted image ${idx}.${saved.ext}`,
        path: saved.filePath,
        mimeType: saved.mimeType,
        dataUrl,
        size: saved.buf.length,
      }
    } catch {
      return null
    }
  })

  server.register('transcribeAudio', (args) => {
    const [audioBase64] = args as [string]
    return transcribeAudio(audioBase64)
  })

  server.register('logVoiceTranscription', async (args) => {
    if (!IS_DEV_MODE) return

    const [row] = args as [VoiceTranscriptionCsvRow]
    try {
      const values = [
        row.sessionIndex,
        row.firstStartedAt,
        row.startedAt,
        row.listeningMs,
        row.transcribeMs,
        row.prompt,
        row.promptChars,
        row.promptWords,
        row.totalListeningMs,
        row.success,
      ].map(csvCell).join(',')

      await mkdir(dirname(VOICE_TRANSCRIPTIONS_CSV), { recursive: true })
      let prefix = ''
      try {
        const existing = await stat(VOICE_TRANSCRIPTIONS_CSV)
        if (existing.size === 0) prefix = VOICE_TRANSCRIPTIONS_CSV_HEADER
      } catch {
        prefix = VOICE_TRANSCRIPTIONS_CSV_HEADER
      }
      await appendFile(VOICE_TRANSCRIPTIONS_CSV, `${prefix}${values}\n`, 'utf8')
    } catch (err) {
      log.warn(`Failed to log voice transcription CSV: ${err}`)
    }
  })

  server.register('searchFiles', async (args) => {
    const [query, cwd] = args as [string, string]
    // Keep the native page small: results render ranked by match score, and a
    // large page buries good matches in noise. fff does not index dotfiles or
    // dot-directories, so hidden paths are intentionally absent from results.
    const MAX = 25

    const cwdRoot = cwd.replace(/\/+$/, '')
    const toDisplay = (p: string): string =>
      p === cwdRoot ? basename(p) : p.startsWith(cwdRoot + '/') ? p.slice(cwdRoot.length + 1) : p

    // Browse mode — no query, or an absolute/home path ending in '/': list the
    // directory's immediate children (readdir) instead of fuzzy-searching a
    // tree. fff would rank deep recursive matches and build a per-base index;
    // for orientation a flat alphabetized listing is both the better UX and
    // the cheaper operation.
    if (!query || (query.endsWith('/') && (query.startsWith('/') || query.startsWith('~/')))) {
      const resolved = query ? resolvePreviewPath(query, cwd) : cwdRoot
      let dirents: { name: string; isDirectory(): boolean }[] = []
      try {
        dirents = await readdir(resolved, { withFileTypes: true })
      } catch {}
      const entries = sortDirEntries(
        dirents.filter(e => !e.name.startsWith('.')).map(e => ({ name: e.name, isDir: e.isDirectory() })),
      )
      return {
        files: entries.map(({ name, isDir }): FileMatch => {
          const path = join(resolved, name)
          return { path, display: toDisplay(path), isDir }
        }),
      }
    }

    // Resolve the query to an fff index base + a fuzzy search string within it.
    // Plain queries fuzzy-search the whole project; path queries inside the
    // project use fff's `dir/` constraint syntax; path queries outside it get
    // a finder bound to the deepest existing directory of the path.
    let base = cwd
    let search = query
    const isPath = query.startsWith('~/') || query.startsWith('./') || query.startsWith('../') || query.startsWith('/')
    if (isPath) {
      const resolved = query.startsWith('~/') ? join(homedir(), query.slice(2)) : pathResolve(cwd, query)
      const rel = pathRelative(cwd, resolved)
      if (!rel.startsWith('..')) {
        search = rel === '' ? '' : rel + (query.endsWith('/') ? '/' : '')
      } else {
        let isDir = false
        try { isDir = statSync(resolved).isDirectory() } catch {}
        base = isDir ? resolved : dirname(resolved)
        search = isDir ? '' : basename(resolved)
      }
    }

    const finder = await getFinder(base)
    if (!finder) return { files: [] }

    const result = finder.mixedSearch(search, { pageSize: MAX })
    if (!result.ok) {
      log.warn(`mixedSearch failed for "${search}" in ${base}: ${result.error}`)
      return { files: [] }
    }

    const files: FileMatch[] = []
    for (const entry of result.value.items) {
      const relativePath =
        entry.type === 'directory' && (
          entry.item.relativePath === '' ||
          entry.item.relativePath === '.' ||
          entry.item.relativePath === '/'
        )
          ? entry.item.dirName.replace(/\/$/, '')
          : entry.item.relativePath
      const path = join(base, relativePath).replace(/\/+$/, '')
      files.push({ path, display: toDisplay(path), isDir: entry.type === 'directory' })
    }

    // Folders first; the sort is stable so match-score order holds within
    // each group and Enter still accepts the best match of the top group.
    files.sort((a, b) => Number(b.isDir) - Number(a.isDir))

    return { files }
  })

  server.register('listDirectory', async (args) => {
    const [rawPath, showHidden] = args as [string, boolean | undefined]
    let resolved: string
    if (rawPath.startsWith('~/')) resolved = join(homedir(), rawPath.slice(2))
    else if (rawPath === '~') resolved = homedir()
    else resolved = pathResolve(rawPath)

    try {
      const dirents = await readdir(resolved, { withFileTypes: true })
      const raw = dirents.map(e => ({ name: e.name, isDir: e.isDirectory() }))
      const filtered = showHidden ? raw : raw.filter(e => !e.name.startsWith('.'))
      const sorted = sortDirEntries(filtered)
      const parent = dirname(resolved)
      return {
        entries: sorted.map(e => ({ name: e.name, isDir: e.isDir, path: join(resolved, e.name) })),
        parentPath: parent === resolved ? null : parent,
        currentPath: resolved,
      }
    } catch {
      return { entries: [], parentPath: dirname(resolved), currentPath: resolved }
    }
  })

  server.register('readProjectFile', async (args) => {
    const [ctx, request] = args as [IpcContext, FilePreviewRequest]
    return readTextFile(ctx, request, { requireProjectRoot: true })
  })

  server.register('listProjectFiles', async (args) => {
    const [ctx, request] = args as [IpcContext, ProjectFilesRequest | undefined]
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    if (!rawRoot) {
      return { ok: false, error: 'No project directory is available.' } satisfies ProjectFilesResult
    }

    let root: string
    try {
      root = await realpath(rawRoot)
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) {
        return { ok: false, root, error: 'Project path is not a directory.' } satisfies ProjectFilesResult
      }
    } catch (err: any) {
      return {
        ok: false,
        root: rawRoot,
        error: err?.message ?? String(err),
      } satisfies ProjectFilesResult
    }

    return await listIndexedProjectFiles(root)
  })

  server.register('writeFile', async (args) => {
    const [ctx, request] = args as [IpcContext, WriteFileRequest]
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    const requestedPath = request?.path ?? ''
    if (!rawRoot) {
      return { ok: false, path: requestedPath, error: 'No project directory is available.' } satisfies WriteFileResult
    }
    if (!requestedPath) {
      return { ok: false, path: requestedPath, error: 'No file path was provided.' } satisfies WriteFileResult
    }

    let root: string
    try {
      root = await realpath(rawRoot)
    } catch (err: any) {
      return {
        ok: false,
        path: requestedPath,
        error: err?.message ?? String(err),
      } satisfies WriteFileResult
    }

    const resolved = resolvePreviewPath(requestedPath, root)
    let target = resolved

    try {
      target = await realpath(resolved)
    } catch {
      try {
        const parent = await realpath(dirname(resolved))
        target = pathResolve(parent, basename(resolved))
      } catch (err: any) {
        return {
          ok: false,
          path: resolved,
          error: err?.message ?? String(err),
        } satisfies WriteFileResult
      }
    }

    if (!isInsideRoot(root, target)) {
      return {
        ok: false,
        path: target,
        error: 'File path is outside the project directory.',
      } satisfies WriteFileResult
    }

    try {
      if (request.expectedContents !== undefined) {
        const currentContents = await readBinaryFile(target, 'utf8')
        if (currentContents !== request.expectedContents) {
          return {
            ok: false,
            path: target,
            error: 'File changed on disk. Reload before saving.',
            conflict: true,
          } satisfies WriteFileResult
        }
      }
      await writeTextFile(target, request.contents, 'utf8')
      await refreshFinder(root)
      return {
        ok: true,
        path: target,
        displayPath: pathRelative(root, target) || basename(target),
        size: Buffer.byteLength(request.contents, 'utf8'),
      } satisfies WriteFileResult
    } catch (err: any) {
      return {
        ok: false,
        path: target,
        error: err?.message ?? String(err),
      } satisfies WriteFileResult
    }
  })

  server.register('openInTerminal', async (args) => {
    const [ctx] = args as [IpcContext]
    const agentId = ctx.settings.activeAgent
    const agentBin = AGENT_BIN[agentId] ?? 'claude'
    const sessionId = ctx.session.agentSessionId
    const projectPath = ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : process.cwd()
    const command = buildAgentTerminalCommand(agentId, agentBin, sessionId, projectPath)
    const terminalId = ctx.settings.defaultTerminal ?? 'default-terminal'
    const launcher = launchInTerminal({ command, terminalId, cwd: projectPath })
    deps.hideAppWindow()
    return launcher
  })

  server.register('openWorktreeTerminal', async (args) => {
    const [ctx] = args as [IpcContext]
    const targetPath = ctx.session.gitContext?.worktreePath
      || (ctx.session.workingDirectory && ctx.session.workingDirectory !== '~' ? ctx.session.workingDirectory : process.cwd())
    if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) return false

    const shellPath = process.env.SHELL || '/bin/zsh'
    const terminalId = ctx.settings.defaultTerminal ?? 'default-terminal'
    const launcher = launchInTerminal({
      command: `exec ${shellQuote(shellPath)} -l`,
      terminalId,
      cwd: targetPath,
    })
    deps.hideAppWindow()
    return launcher
  })

  server.register('detectEditors', () => {
    log.info('RPC detectEditors')

    const editors: DetectedEditor[] = []
    const probes: Array<{ id: EditorId; name: string; bin: string; isTerminal: boolean }> = [
      { id: 'vscode', name: 'VS Code', bin: 'code', isTerminal: false },
      { id: 'vim', name: 'Vim', bin: 'vim', isTerminal: true },
      { id: 'nvim', name: 'Neovim', bin: 'nvim', isTerminal: true },
      { id: 'helix', name: 'Helix', bin: 'hx', isTerminal: true },
    ]
    for (const p of probes) {
      try {
        const binPath = execFileSync('/usr/bin/which', [p.bin], { encoding: 'utf8', timeout: 2000, env: getCliEnv() }).trim()
        if (binPath) editors.push({ id: p.id, name: p.name, isTerminal: p.isTerminal, binPath })
      } catch {}
    }

    const terminals: DetectedTerminal[] = [{ id: 'default-terminal', name: 'Default Terminal' }]
    if (process.platform === 'darwin') {
      if (existsSync('/Applications/Ghostty.app')) terminals.push({ id: 'ghostty', name: 'Ghostty' })
    } else {
      try { execFileSync('/usr/bin/which', ['ghostty'], { encoding: 'utf8', timeout: 2000 }); terminals.push({ id: 'ghostty', name: 'Ghostty' }) } catch {}
    }

    log.info(`Detected editors: ${editors.map(e => e.id).join(', ')}; terminals: ${terminals.map(t => t.id).join(', ')}`)
    return { editors, terminals }
  })

  server.register('openInEditor', async (args) => {
    const [ctx, request] = args as [IpcContext, OpenInEditorRequest]
    const { filePaths } = request
    const editorId = ctx.settings.defaultEditor ?? request.editorId
    const terminalId = ctx.settings.defaultTerminal ?? request.terminalId
    const cwd = request.cwd || (filePaths.length > 0 ? dirname(filePaths[0]) : undefined)
    log.info(`RPC openInEditor editor=${editorId} terminal=${terminalId} cwd=${cwd} files=${filePaths.join(', ')}`)

    if (editorId === 'vscode') {
      return new Promise<boolean>((resolve) => {
        execFile('code', filePaths, (err: Error | null) => {
          if (err) { log.error(`Failed to open VS Code: ${err.message}`); resolve(false) }
          else {
            if (process.platform === 'darwin') {
              execFile('/usr/bin/osascript', ['-e', 'tell application "Visual Studio Code" to activate'], () => {})
            }
            resolve(true)
          }
        })
      })
    }

    const binMap: Record<string, string> = { vim: 'vim', nvim: 'nvim', helix: 'hx' }
    const bin = binMap[editorId]
    if (!bin) { log.warn(`Unknown editor: ${editorId}`); return false }

    const escapedPaths = filePaths.map(p => `"${p.replace(/"/g, '\\"')}"`)
    const command = `${bin} ${escapedPaths.join(' ')}`

    const launched = launchInTerminal({ command, terminalId: terminalId || 'default-terminal', cwd })
    deps.hideAppWindow()
    return launched
  })
}
