import { dialog, shell } from 'electron'
import { takeDesktopScreenshot } from '../../capture/screenshot'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import { join, dirname } from 'path'
import { existsSync, writeFileSync, statSync } from 'fs'
import { appendFile, mkdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import type { AgentId, DetectedEditor } from '@solus/contracts/types'
import { AGENT_BIN } from '@solus/contracts/types'
import { MAX_VOICE_WAV_BYTES } from '@solus/contracts/voice-audio'
import { IMAGE_FILE_EXTENSIONS, VIDEO_FILE_EXTENSIONS } from '@solus/contracts/media-types'
import { transcribeAudio, warmTranscription } from '@solus/desktop-main/transcription'
import { readWav } from '@solus/server/transcription/wav'
import { getVoiceModelStatus, retryParakeetModel } from '@solus/server/model-downloader'
import { desktopPlatform } from '@solus/desktop-main/platform/desktop-platform'
import { EDITOR_APPS, editorApp } from '@solus/desktop-main/editor-apps'
import { warmCliPath } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { solusDir, resolveHomePath } from '@solus/server/platform/paths'
import type { SolusServer } from '@solus/server/transport/server'
import { filePathsToAttachments } from '@solus/server/transport/attachment-utils'
import { allowClientAttachmentReads } from '@solus/desktop-main/client-attachment-read'

const log = createLogger('main', 'file-handlers')
const { terminal } = desktopPlatform

export interface FileDeps {
  /** The desktop workspace window used by dialogs and screenshots. */
  getWorkspaceWindow(): BrowserWindow | null
  hideAppWindow(): void
  /** Used by takeScreenshot to restore + focus the window after capturing. */
  showAndFocusWorkspaceWindow(): void
  bumpScreenshotCounter(): number
  bumpPasteCounter(): number
  /** Whether a capture can run now. Asks macOS for Screen Recording on first use. */
  ensureScreenCaptureAccess(): Promise<boolean>
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
    const win = deps.getWorkspaceWindow()
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

  server.register('attachFiles', async () => {
    const win = deps.getWorkspaceWindow()
    if (!win) return null
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: [...IMAGE_FILE_EXTENSIONS] },
        { name: 'Videos', extensions: [...VIDEO_FILE_EXTENSIONS] },
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

  let takingScreenshot = false
  server.register('takeScreenshot', async () => {
    if (takingScreenshot) throw new Error('A screenshot request is already open.')
    const win = deps.getWorkspaceWindow()
    if (!win) return null
    if (!(await deps.ensureScreenCaptureAccess())) return null

    if (takingScreenshot) throw new Error('A screenshot request is already open.')
    takingScreenshot = true
    const controller = new AbortController()
    const abort = () => controller.abort()
    win.once('closed', abort)
    try {
      win.hide()
      await new Promise((r) => setTimeout(r, 300))
      return await takeDesktopScreenshot(`screenshot ${deps.bumpScreenshotCounter()}.png`, controller.signal)
    } finally {
      takingScreenshot = false
      win.removeListener('closed', abort)
      deps.showAndFocusWorkspaceWindow()
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

  server.register('openInTerminal', async (args) => {
    const [ctx] = args
    const agentId = ctx.settings.activeAgent
    const agentBin = AGENT_BIN[agentId] ?? 'claude'
    const sessionId = ctx.session.agentSessionId
    const projectPath = resolveHomePath(ctx.session.workingDirectory || '~')
    const command = buildAgentTerminalCommand(agentId, agentBin, sessionId)
    const fallbackTerminalId = ctx.settings.fallbackTerminal ?? 'default-terminal'
    const launcher = await terminal.launch({ command, fallbackTerminalId, cwd: projectPath })
    if (launcher && terminal.hidesAppAfterLaunch) deps.hideAppWindow()
    return launcher
  })

  server.register('openWorktreeTerminal', async (args) => {
    const [ctx] = args
    const targetPath = resolveHomePath(ctx.session.gitContext?.worktreePath || ctx.session.workingDirectory || '~')
    if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) return false

    const fallbackTerminalId = ctx.settings.fallbackTerminal ?? 'default-terminal'
    const launcher = await terminal.launch({ command: terminal.shellCommand(process.env), fallbackTerminalId, cwd: targetPath })
    if (launcher && terminal.hidesAppAfterLaunch) deps.hideAppWindow()
    return launcher
  })

  server.register('resolveTerminal', (args) => {
    const [fallbackTerminalId] = args
    return terminal.resolve(fallbackTerminalId ?? 'default-terminal')
  })

  server.register('detectEditors', async () => {
    log.info('rpc_detect_editors')
    // Join boot's PATH probe; a cold capability read must not start a blocking
    // login shell probe of its own. One path serves every editor and terminal.
    const cliPath = await warmCliPath()

    const editors = EDITOR_APPS
      .map((app) => desktopPlatform.editors.detect(app, cliPath))
      .filter((editor): editor is DetectedEditor => !!editor)
    const terminals = await terminal.detect(cliPath)

    log.info('editors_detected', { editors: editors.map(e => e.id), terminals: terminals.map(t => t.id) })
    return { editors, terminals }
  })

  server.register('openInEditor', async (args) => {
    const [ctx, request] = args
    const { filePaths } = request
    const editorId = ctx.settings.defaultEditor ?? request.editorId
    const fallbackTerminalId = ctx.settings.fallbackTerminal ?? request.fallbackTerminalId
    const cwd = request.cwd || (filePaths.length > 0 ? dirname(filePaths[0]) : undefined)
    log.info('rpc_open_in_editor', { editorId, fallbackTerminalId, cwd, filePaths })

    const app = editorApp(editorId)
    if (!app) { log.warn('unknown_editor', { editorId }); return false }

    if (!app.isTerminal) return desktopPlatform.editors.open(app, filePaths, await warmCliPath())

    const escapedPaths = filePaths.map(p => `"${p.replace(/"/g, '\\"')}"`)
    const command = [app.bin, ...(app.args ?? []), ...escapedPaths].join(' ')

    const launched = await terminal.launch({ command, fallbackTerminalId: fallbackTerminalId || 'default-terminal', cwd })
    if (launched && terminal.hidesAppAfterLaunch) deps.hideAppWindow()
    return launched
  })
}
