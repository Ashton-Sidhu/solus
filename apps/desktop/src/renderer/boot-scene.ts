/**
 * The pre-Svelte boot surface: everything the user can see between the static
 * shell in index.html and App mounting. index.css has not loaded here, so every
 * value is a literal — kept in sync with the `--solus-edge-bg` / accent tokens
 * by hand.
 *
 * The shell already paints a centred 4.5rem mark on the edge background. This
 * module re-renders that same mark, at the same size and centre, and hangs
 * detail beneath it — so a boot failure reads as the splash gaining
 * information rather than a second screen replacing the first.
 */

import { describeConnectionFailure } from '@solus/client-core/connection-display'

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
       nothing reflows as stages appear. The anchor then lifts by half the detail
       height so the mark and its detail are centred as one group — the mark
       starts at the shell's centre and settles up, which reads as one
       continuous scene rather than a cut. */
    .solus-boot-anchor {
      position: relative;
      transform: translateY(calc(var(--solus-boot-lift, 0px) * -1));
      transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1);
    }
    .solus-boot-mark { display: block; width: 5.25rem; height: 5.25rem; opacity: 0.34; }

    /* Wide enough for a stack trace to breathe. Prose and stages stay at a
       readable measure inside it; only the trace uses the full width. */
    .solus-boot-detail {
      position: absolute;
      top: calc(100% + 1.75rem);
      left: 50%;
      transform: translateX(-50%);
      width: min(40rem, calc(100vw - 3rem));
      display: flex;
      flex-direction: column;
      align-items: center;
      opacity: 0;
      transition: opacity 0.4s ease-out;
    }
    .solus-boot-detail[data-shown='true'] { opacity: 1; }

    .solus-boot-title { margin-top: 1.0625rem; font-size: var(--text-sm); font-weight: 500; line-height: 1.3; text-align: center; max-width: 22rem; }
    .solus-boot-message { margin-top: 0.4375rem; font-size: var(--text-sm); line-height: 1.5; color: var(--solus-boot-tertiary); text-align: center; max-width: 22rem; }

    .solus-boot-actions { margin-top: 1.0625rem; display: flex; gap: 0.5rem; }
    .solus-boot-button {
      appearance: none;
      cursor: pointer;
      font: inherit;
      font-size: var(--text-sm);
      padding: 0.375rem 0.8125rem;
      border-radius: 0.5rem;
      border: 0.0625rem solid transparent;
      transition: filter 0.2s ease, background-color 0.2s ease, color 0.2s ease;
    }
    .solus-boot-button[data-variant='primary'] { background: var(--solus-boot-accent); color: #ffffff; }
    .solus-boot-button[data-variant='primary']:hover { filter: brightness(1.06); }

    .solus-boot-details {
      margin-top: 1rem;
      width: 100%;
      border-radius: 0.5625rem;
      border: 0.0625rem solid var(--solus-boot-hairline);
      background: var(--solus-boot-raised);
      text-align: left;
      overflow: hidden;
    }
    .solus-boot-details summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.5rem 0.5rem 0.5rem 0.75rem;
      font-size: var(--text-sm);
      color: var(--solus-boot-secondary);
    }
    .solus-boot-details summary::-webkit-details-marker { display: none; }
    .solus-boot-details[open] summary { border-bottom: 0.0625rem solid var(--solus-boot-hairline); }
    .solus-boot-copy {
      appearance: none;
      cursor: pointer;
      font: inherit;
      font-size: var(--text-xs);
      padding: 0.1875rem 0.5rem;
      border-radius: 0.3125rem;
      border: 0.0625rem solid var(--solus-boot-hairline);
      background: transparent;
      color: var(--solus-boot-secondary);
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .solus-boot-copy:hover { background: var(--solus-boot-raised); color: inherit; }
    .solus-boot-copy[data-copied='true'] { color: var(--solus-boot-accent); border-color: var(--solus-boot-accent); }
    .solus-boot-details pre {
      margin: 0;
      padding: 0.625rem 0.75rem;
      max-height: 18rem;
      overflow: auto;
      font-size: var(--text-xs);
      line-height: 1.65;
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
      color: var(--solus-boot-secondary);
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }

    @media (prefers-reduced-motion: reduce) {
      .solus-boot-anchor, .solus-boot-detail { transition: none !important; }
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
 * `navigator.clipboard` is unavailable on non-secure origins — which includes
 * the web client served over plain http on a LAN, exactly where a connection
 * failure is most likely. Mirrors the fallback in `ui/CopyButton.svelte`.
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  document.body.appendChild(scratch)
  scratch.select()
  document.execCommand('copy')
  document.body.removeChild(scratch)
}

function copyTraceButton(raw: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'solus-boot-copy'
  button.textContent = 'Copy'
  button.addEventListener('click', (event) => {
    // The button lives inside <summary>, where a click would otherwise toggle
    // the disclosure shut on the way to the clipboard.
    event.preventDefault()
    event.stopPropagation()
    void copyText(raw).then(() => {
      button.dataset.copied = 'true'
      button.textContent = 'Copied'
      setTimeout(() => {
        delete button.dataset.copied
        button.textContent = 'Copy'
      }, 1500)
    }).catch(() => {})
  })
  return button
}

/** Gap between the mark and its detail, matching `.solus-boot-detail`'s top. */
const DETAIL_GAP_PX = 28

/**
 * Builds the scene once and refills it thereafter. Re-creating the whole tree on
 * every status change would replay the entrance and snap the anchor back to the
 * shell's centre mid-transition.
 */
function mountScene(root: HTMLElement, content: string): HTMLElement {
  ensureBootStyles()
  if (!root.querySelector('.solus-boot-anchor')) {
    root.innerHTML = `
      <div class="solus-boot">
        <div class="solus-boot-anchor">
          ${MARK}
          <div class="solus-boot-detail"></div>
        </div>
      </div>
    `
  }
  const anchor = root.querySelector<HTMLElement>('.solus-boot-anchor')!

  const detail = anchor.querySelector<HTMLElement>('.solus-boot-detail')!
  detail.innerHTML = content

  // Lift the anchor by half the detail block so mark + detail read as one
  // centred group. Measured after paint, because the height depends on how many
  // lines the copy wrapped to.
  requestAnimationFrame(() => {
    anchor.style.setProperty('--solus-boot-lift', `${(DETAIL_GAP_PX + detail.offsetHeight) / 2}px`)
    detail.dataset.shown = 'true'
  })
  return detail
}

/**
 * The terminal state. Deliberately still: a spinner here would animate exactly
 * like a connection that is still working, which is what the old boot error
 * did.
 */
export function renderFatal(
  root: HTMLElement,
  options: { hostLabel: string; error: unknown },
): void {
  const { hostLabel, error } = options
  const { title, detail: message } = describeConnectionFailure(hostLabel, error)
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error)

  const detail = mountScene(root, `
    <div class="solus-boot-title">${escapeHtml(title)}</div>
    <div class="solus-boot-message">${escapeHtml(message)}</div>
    <div class="solus-boot-actions"></div>
    <details class="solus-boot-details">
      <summary><span>Technical details</span></summary>
      <pre>${escapeHtml(raw)}</pre>
    </details>
  `)

  const actions = detail.querySelector<HTMLElement>('.solus-boot-actions')
  actions?.appendChild(bootButton('Try again', 'primary', () => location.reload()))
  detail.querySelector('.solus-boot-details summary')?.appendChild(copyTraceButton(raw))
}

function bootButton(label: string, variant: 'primary', onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'solus-boot-button'
  button.dataset.variant = variant
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}
