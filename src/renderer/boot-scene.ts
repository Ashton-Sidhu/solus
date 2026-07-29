/**
 * The pre-Svelte boot surface: everything the user can see between the static
 * shell in index.html and App mounting. index.css has not loaded here, so every
 * value is a literal — kept in sync with the `--solus-edge-bg` / accent tokens
 * by hand.
 *
 * The shell already paints a centred 4.5rem mark on the edge background. This
 * module re-renders that same mark, at the same size and centre, and hangs
 * detail beneath it — so a remote connect reads as the splash gaining
 * information rather than a second screen replacing the first.
 */

import { LOCAL_SERVER_ID, setActiveServerId } from '@client-core/server-registry'
import { describeConnectionFailure } from '@client-core/connection-display'
import type { ConnectionStatus } from '@client-core/ws-transport'

/** Stages the boot scene can actually observe. Nothing here is simulated. */
interface BootStage {
  label: string
  state: 'idle' | 'active' | 'done'
}

const STYLE_ID = 'solus-boot-styles'

const MARK = `
  <svg class="solus-boot-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">
    <circle cx="512" cy="512" r="180" fill="#B45A3C" />
    <g fill="none" stroke="#D97757" stroke-width="60" stroke-linecap="round">
      <path d="M512,212 A300,300 0 0 1 812,512" />
      <path d="M764,716 A300,300 0 0 1 416,800" />
      <path d="M260,716 A300,300 0 0 1 212,416" />
    </g>
  </svg>
`

function ensureBootStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .solus-boot {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      background: #1c1b18;
      color: #f0ece3;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      font-variant-numeric: tabular-nums;
      --solus-boot-secondary: #bfb9aa;
      --solus-boot-tertiary: #7a7568;
      --solus-boot-hairline: rgba(255, 255, 255, 0.10);
      --solus-boot-raised: rgba(255, 255, 255, 0.04);
      --solus-boot-accent: #e08a6e;
    }
    html.light .solus-boot {
      background: #fbfaf6;
      color: #2a2618;
      --solus-boot-secondary: #484538;
      --solus-boot-tertiary: #7d7a6e;
      --solus-boot-hairline: rgba(0, 0, 0, 0.09);
      --solus-boot-raised: rgba(0, 0, 0, 0.03);
      --solus-boot-accent: #d97757;
    }

    /* The mark stays pinned to the shell's centre; detail hangs below it, so
       nothing shifts as stages appear. */
    .solus-boot-anchor { position: relative; }
    .solus-boot-mark { display: block; width: 4.5rem; height: 4.5rem; }
    .solus-boot-anchor[data-live='true'] .solus-boot-mark {
      animation: solus-boot-breathe 1.8s ease-in-out infinite;
    }
    .solus-boot-anchor[data-live='false'] .solus-boot-mark { opacity: 0.34; }

    .solus-boot-detail {
      position: absolute;
      top: calc(100% + 1.5rem);
      left: 50%;
      transform: translateX(-50%);
      width: 17rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      animation: solus-boot-rise 0.45s ease-out both;
    }

    .solus-boot-host { font-size: 0.8125rem; font-weight: 500; line-height: 1.2; }
    .solus-boot-url { margin-top: 0.25rem; font-size: 0.6875rem; color: var(--solus-boot-tertiary); }

    .solus-boot-stages { margin-top: 1.25rem; width: 100%; }
    .solus-boot-step { display: flex; align-items: center; gap: 0.5625rem; padding: 0.3125rem 0; }
    .solus-boot-bullet { position: relative; width: 0.875rem; height: 0.875rem; flex: none; display: grid; place-items: center; }
    .solus-boot-bullet::before {
      content: '';
      width: 0.375rem;
      height: 0.375rem;
      border-radius: 999px;
      background: var(--solus-boot-hairline);
      transition: background-color 0.3s ease, transform 0.3s ease;
    }
    .solus-boot-step[data-state='active'] .solus-boot-bullet::before { background: var(--solus-boot-accent); transform: scale(1.15); }
    .solus-boot-step[data-state='done'] .solus-boot-bullet::before { background: var(--solus-boot-accent); opacity: 0.55; }
    .solus-boot-step[data-state='active'] .solus-boot-bullet::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 999px;
      border: 0.09375rem solid var(--solus-boot-accent);
      animation: solus-boot-ping 1.5s ease-out infinite;
    }
    .solus-boot-step-label { font-size: 0.75rem; color: var(--solus-boot-tertiary); transition: color 0.3s ease; }
    .solus-boot-step[data-state='active'] .solus-boot-step-label { color: inherit; }
    .solus-boot-step[data-state='done'] .solus-boot-step-label { color: var(--solus-boot-secondary); }

    .solus-boot-retry {
      margin-top: 1.0625rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.6875rem;
      color: var(--solus-boot-tertiary);
      animation: solus-boot-rise 0.45s ease-out both;
    }

    .solus-boot-title { margin-top: 0.9375rem; font-size: 0.9375rem; font-weight: 500; line-height: 1.3; text-align: center; }
    .solus-boot-message { margin-top: 0.375rem; font-size: 0.75rem; line-height: 1.5; color: var(--solus-boot-tertiary); text-align: center; }

    .solus-boot-actions { margin-top: 0.9375rem; display: flex; gap: 0.4375rem; }
    .solus-boot-button {
      appearance: none;
      cursor: pointer;
      font: inherit;
      font-size: 0.71875rem;
      padding: 0.3125rem 0.6875rem;
      border-radius: 0.4375rem;
      border: 0.0625rem solid transparent;
      transition: filter 0.2s ease, background-color 0.2s ease, color 0.2s ease;
    }
    .solus-boot-button[data-variant='primary'] { background: var(--solus-boot-accent); color: #ffffff; }
    .solus-boot-button[data-variant='primary']:hover { filter: brightness(1.06); }
    .solus-boot-button[data-variant='ghost'] { border-color: var(--solus-boot-hairline); color: var(--solus-boot-secondary); background: transparent; }
    .solus-boot-button[data-variant='ghost']:hover { background: var(--solus-boot-raised); color: inherit; }
    .solus-boot-link {
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      font-size: 0.6875rem;
      color: var(--solus-boot-accent);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 0.125rem;
    }

    .solus-boot-details {
      margin-top: 0.875rem;
      width: 100%;
      border-radius: 0.5rem;
      border: 0.0625rem solid var(--solus-boot-hairline);
      background: var(--solus-boot-raised);
      text-align: left;
      overflow: hidden;
    }
    .solus-boot-details summary {
      cursor: pointer;
      list-style: none;
      padding: 0.375rem 0.625rem;
      font-size: 0.6875rem;
      color: var(--solus-boot-tertiary);
    }
    .solus-boot-details summary::-webkit-details-marker { display: none; }
    .solus-boot-details pre {
      margin: 0;
      padding: 0 0.625rem 0.5625rem;
      font-size: 0.625rem;
      line-height: 1.5;
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
      color: var(--solus-boot-tertiary);
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }

    @keyframes solus-boot-breathe {
      0%, 100% { opacity: 0.4; transform: scale(0.97); }
      50% { opacity: 0.95; transform: scale(1); }
    }
    @keyframes solus-boot-ping {
      0% { transform: scale(0.45); opacity: 0.7; }
      100% { transform: scale(1.15); opacity: 0; }
    }
    @keyframes solus-boot-rise {
      from { opacity: 0; transform: translate(-50%, 0.375rem); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .solus-boot-mark, .solus-boot-bullet::after, .solus-boot-detail, .solus-boot-retry { animation: none !important; }
      .solus-boot-detail { transform: translateX(-50%); }
    }
  `
  document.head.appendChild(style)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

/**
 * Two stages, because two are all the transport can honestly report: the socket
 * is either still dialling, or open and the workspace is being restored. A
 * third invented stage would make a stall point at the wrong place.
 */
function connectStages(status: ConnectionStatus, hostLabel: string): BootStage[] {
  const open = status === 'connected'
  return [
    { label: `Reaching ${hostLabel}`, state: open ? 'done' : 'active' },
    { label: 'Restoring your workspace', state: open ? 'active' : 'idle' },
  ]
}

function stagesMarkup(stages: BootStage[]): string {
  const steps = stages.map((stage) => `
    <div class="solus-boot-step" data-state="${stage.state}">
      <span class="solus-boot-bullet"></span>
      <span class="solus-boot-step-label">${escapeHtml(stage.label)}</span>
    </div>
  `).join('')
  return `<div class="solus-boot-stages">${steps}</div>`
}

function useLocalHost(): void {
  setActiveServerId(LOCAL_SERVER_ID)
  location.reload()
}

function mountScene(root: HTMLElement, live: boolean, detail: string): HTMLElement {
  ensureBootStyles()
  root.innerHTML = `
    <div class="solus-boot">
      <div class="solus-boot-anchor" data-live="${live}">
        ${MARK}
        <div class="solus-boot-detail">${detail}</div>
      </div>
    </div>
  `
  return root.querySelector('.solus-boot-detail') as HTMLElement
}

/**
 * The remote-connect splash. Local targets never reach this — they mount
 * straight through the static shell, which is faster than any progress UI.
 */
export function renderConnecting(
  root: HTMLElement,
  options: { hostLabel: string; hostUrl: string; status: ConnectionStatus; attempt: number },
): void {
  const { hostLabel, hostUrl, status, attempt } = options
  // The first attempt is the expected path; offering an escape hatch there
  // would read as a warning about a connection that is merely in progress.
  const struggling = attempt > 1
  const detail = mountScene(root, true, `
    <div class="solus-boot-host">${escapeHtml(hostLabel)}</div>
    <div class="solus-boot-url">${escapeHtml(hostUrl)}</div>
    ${stagesMarkup(connectStages(status, hostLabel))}
    ${struggling ? `<div class="solus-boot-retry"><span>Attempt ${attempt}</span></div>` : ''}
  `)

  if (!struggling) return
  const escapeHatch = document.createElement('button')
  escapeHatch.type = 'button'
  escapeHatch.className = 'solus-boot-link'
  escapeHatch.textContent = 'Use this Mac instead'
  escapeHatch.addEventListener('click', useLocalHost)
  detail.querySelector('.solus-boot-retry')?.appendChild(escapeHatch)
}

/**
 * The terminal state. Deliberately still: a spinner here would animate exactly
 * like a connection that is still working, which is what the old boot error
 * did.
 */
export function renderFatal(
  root: HTMLElement,
  options: { hostLabel: string; isLocalHost: boolean; error: unknown },
): void {
  const { hostLabel, isLocalHost, error } = options
  const { title, detail: message } = describeConnectionFailure(hostLabel, error)
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error)

  const detail = mountScene(root, false, `
    <div class="solus-boot-title">${escapeHtml(title)}</div>
    <div class="solus-boot-message">${escapeHtml(message)}</div>
    <div class="solus-boot-actions"></div>
    <details class="solus-boot-details">
      <summary>Technical details</summary>
      <pre>${escapeHtml(raw)}</pre>
    </details>
  `)

  const actions = detail.querySelector('.solus-boot-actions') as HTMLElement
  actions.appendChild(bootButton('Try again', 'primary', () => location.reload()))
  if (!isLocalHost) actions.appendChild(bootButton('Use this Mac', 'ghost', useLocalHost))
}

function bootButton(label: string, variant: 'primary' | 'ghost', onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'solus-boot-button'
  button.dataset.variant = variant
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}
