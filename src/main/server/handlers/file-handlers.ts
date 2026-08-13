import { dialog, shell } from 'electron'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import { join, basename, dirname, resolve as pathResolve, relative as pathRelative } from 'path'
import { existsSync, writeFileSync, readFileSync, statSync } from 'fs'
import { appendFile, mkdir, readFile as readBinaryFile, readdir, realpath, stat, writeFile as writeTextFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { execFile, execFileSync } from 'child_process'
import type { AgentId, ProjectContentSearchResult, WriteFileResult, FileMatch, DetectedEditor, DetectedTerminal, EditorId } from '../../../shared/types'
import { AGENT_BIN } from '../../../shared/types'
import { MAX_VOICE_WAV_BYTES } from '../../../shared/voice-audio'
import { transcribeAudio, warmTranscription } from '../../transcription'
import { readWav } from '../../transcription/wav'
import { getVoiceModelStatus, retryParakeetModel } from '../../model-downloader'
import { launchInTerminal } from '../../terminal-launcher'
import { getCliEnv } from '../../cli-env'
import { createLogger } from '../../logger'
import { solusDir } from '../../platform/paths'
import { getFinder, refreshFinder } from '../file-finder'
import { sortDirEntries } from './filesystem-handlers'
import { isInsideRoot, projectRootForRequest, readFilePreview, resolvePreviewPath } from './lib/file-preview'
import { searchProjectContents } from './lib/content-search'
import type { SolusServer } from '../server'
import { filePathsToAttachments } from '../attachment-utils'
import { allowClientAttachmentReads } from '../../client-attachment-read'

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
  /** Expands the hidden design-mode window over the captured work area. */
  expandDesignModeWindow(bounds: { x: number; y: number; width: number; height: number }): void
  /** Restores the window after design mode (opacity, alwaysOnTop, visibility, focus). */
  restoreDesignModeWindow(): void
  /** Leaves design mode and restores the window's original bounds. */
  exitDesignModeWindow(): void
  bumpScreenshotCounter(): number
  bumpDesignModeCounter(): number
  bumpPasteCounter(): number
  /** Returns the work-area rect of the cursor's display, used as design-mode capture region. */
  designModeCaptureRegion(): { x: number; y: number; width: number; height: number }
}

const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)
const VOICE_TRANSCRIPTIONS_CSV = join(solusDir(), 'voice-transcriptions.csv')
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

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
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

function buildAgentTerminalCommand(agentId: AgentId, agentBin: string, sessionId: string | null): string {
  if (agentId === 'claude-code') {
    return sessionId ? `${agentBin} --resume ${shellQuote(sessionId)}` : agentBin
  }
  if (agentId === 'codex') {
    return sessionId ? `${agentBin} resume ${shellQuote(sessionId)}` : agentBin
  }
  return sessionId ? `${agentBin} --resume ${shellQuote(sessionId)}` : agentBin
}

export function registerFileHandlers(server: SolusServer, deps: FileDeps): void {
  server.register('saveFileDialog', async (args) => {
    const [defaultName, content] = args
    const win = deps.getActiveWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content, 'utf8')
    return result.filePath
  })

  server.register('openExternal', async (args) => {
    const [url, options] = args
    try {
      if (!/^https?:\/\//i.test(url)) return false
      await shell.openExternal(url)
      if (options?.hideAppAfterOpen) deps.hideAppWindow()
      return true
    } catch {
      return false
    }
  })

  // Reveals a folder in the desktop's own file manager — Finder on macOS,
  // Explorer on Windows, the xdg default on Linux.
  server.register('openInFileManager', async (args) => {
    const [target] = args
    try {
      if (!target || !statSync(target).isDirectory()) return false
    } catch {
      return false
    }
    const failure = await shell.openPath(target)
    if (failure) {
      log.warn('open_in_file_manager_failed', { target, error: failure })
      return false
    }
    return true
  })

  server.register('attachFiles', async () => {
    const win = deps.getActiveWindow()
    if (!win) return null
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
        { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
      ],
    }
    const result = await dialog.showOpenDialog(win, options)
    if (result.canceled || result.filePaths.length === 0) return null
    allowClientAttachmentReads(result.filePaths)
    return filePathsToAttachments(result.filePaths)
  })

  server.register('attachFilePaths', async (args) => {
    const [filePaths] = args
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
    // One compositor frame is enough for the transparent window to disappear.
    // Keeping this short makes the captured desktop and the overlay read as one
    // continuous surface instead of exposing the desktop for 300ms.
    await new Promise((r) => setTimeout(r, 50))

    try {
      const screenshotPath = join(tmpdir(), `solus-design-${Date.now()}.png`)
      await runScreencapture(['-x', '-R', `${wx},${wy},${ww},${wh}`, screenshotPath], 10000)

      if (!existsSync(screenshotPath)) return null

      // Resize only after capture so the invisible window cannot affect the
      // pixels being sampled. It stays hidden until the renderer has painted.
      deps.expandDesignModeWindow({ x: wx, y: wy, width: ww, height: wh })
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

  server.register('exitDesignMode', () => {
    deps.exitDesignModeWindow()
  })

  server.register('submitDesignAnnotations', async (args) => {
    const [data] = args
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
    const [dataUrl] = args
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
    const [audio] = args
    if (audio instanceof Float32Array) return transcribeAudio(audio)
    const maxBase64Chars = Math.ceil(MAX_VOICE_WAV_BYTES / 3) * 4
    if (audio.length > maxBase64Chars) {
      return { error: 'Voice recording exceeds the 60 minute limit', transcript: null }
    }
    return transcribeAudio(readWav(Buffer.from(audio, 'base64')))
  })

  server.register('warmTranscription', () => warmTranscription())

  server.register('voiceModelStatus', () => getVoiceModelStatus())

  server.register('voiceModelRetry', async () => {
    try {
      await retryParakeetModel()
    } catch {}
    return getVoiceModelStatus()
  })

  server.register('logVoiceTranscription', async (args) => {
    if (!IS_DEV_MODE) return

    const [row] = args
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
      log.warn('voice_transcription_csv_write_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  })

  server.register('searchFiles', async (args) => {
    const [query, cwd] = args
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
      log.warn('search_files_mixed_search_failed', { search, base, error: result.error })
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

    // mixedSearch already returns relevance order. Unlike browse mode above,
    // do not regroup directories ahead of files after the user starts typing.
    return { files }
  })

  server.register('searchProjectContents', async (args) => {
    const [ctx, request] = args
    // Scoped to the caller's environment cwd, which already resolves to the
    // worktree path for an isolated session — searching the main checkout would
    // return matches the session cannot act on.
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    if (!rawRoot) return { ok: false, error: 'No project directory is available.' } satisfies ProjectContentSearchResult

    let root: string
    try {
      root = await realpath(rawRoot)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ProjectContentSearchResult
    }
    return searchProjectContents(root, request)
  })

  server.register('readProjectFile', async (args) => {
    const [ctx, request] = args
    return readFilePreview(ctx, request)
  })

  server.register('writeFile', async (args) => {
    const [ctx, request] = args
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
    } catch (err) {
      return {
        ok: false,
        path: requestedPath,
        error: err instanceof Error ? err.message : String(err),
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
      } catch (err) {
        return {
          ok: false,
          path: resolved,
          error: err instanceof Error ? err.message : String(err),
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
    } catch (err) {
      return {
        ok: false,
        path: target,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WriteFileResult
    }
  })

  server.register('openInTerminal', async (args) => {
    const [ctx] = args
    const agentId = ctx.settings.activeAgent
    const agentBin = AGENT_BIN[agentId] ?? 'claude'
    const sessionId = ctx.session.agentSessionId
    const projectPath = ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : process.cwd()
    const command = buildAgentTerminalCommand(agentId, agentBin, sessionId)
    const terminalId = ctx.settings.defaultTerminal ?? 'default-terminal'
    const launcher = launchInTerminal({ command, terminalId, cwd: projectPath })
    deps.hideAppWindow()
    return launcher
  })

  server.register('openWorktreeTerminal', async (args) => {
    const [ctx] = args
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
    log.info('rpc_detect_editors')

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

    log.info('editors_detected', { editors: editors.map(e => e.id), terminals: terminals.map(t => t.id) })
    return { editors, terminals }
  })

  server.register('openInEditor', async (args) => {
    const [ctx, request] = args
    const { filePaths } = request
    const editorId = ctx.settings.defaultEditor ?? request.editorId
    const terminalId = ctx.settings.defaultTerminal ?? request.terminalId
    const cwd = request.cwd || (filePaths.length > 0 ? dirname(filePaths[0]) : undefined)
    log.info('rpc_open_in_editor', { editorId, terminalId, cwd, filePaths })

    if (editorId === 'vscode') {
      return new Promise<boolean>((resolve) => {
        execFile('code', filePaths, (err: Error | null) => {
          if (err) { log.error('open_vscode_failed', { error: err.message }); resolve(false) }
          else {
            if (process.platform === 'darwin') {
              execFile('/usr/bin/osascript', ['-e', 'tell application "Visual Studio Code" to activate'], () => {})
            }
            resolve(true)
          }
        })
      })
    }

    const binMap = { vim: 'vim', nvim: 'nvim', helix: 'hx' } satisfies Partial<Record<EditorId, string>>
    const bin = binMap[editorId]
    if (!bin) { log.warn('unknown_editor', { editorId }); return false }

    const escapedPaths = filePaths.map(p => `"${p.replace(/"/g, '\\"')}"`)
    const command = `${bin} ${escapedPaths.join(' ')}`

    const launched = launchInTerminal({ command, terminalId: terminalId || 'default-terminal', cwd })
    deps.hideAppWindow()
    return launched
  })
}
