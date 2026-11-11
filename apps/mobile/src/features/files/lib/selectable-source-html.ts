/**
 * The page for selecting file text on Android: the whole file as escaped
 * plain text, one `<span id="L<n>">` per line, so selection crosses lines and
 * the page can scroll to a line. One native Text with a large file blocks the
 * Android UI thread (T3 Code froze on a 16,000-line file); a web view lays the
 * text out off that thread.
 */

export interface SelectableSourceHtmlStyle {
  readonly foreground: string
  readonly selection: string
  readonly fontSize: number
  readonly rowHeight: number
  readonly wordBreak: boolean
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

// A <pre> drops a leading newline, so a plain <div> keeps the whitespace.
export function selectableSourceHtml(contents: string, style: SelectableSourceHtmlStyle): string {
  const text = contents
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => `<span id="L${index + 1}">${escapeHtml(line)}</span>`)
    .join('\n')
  const wrap = style.wordBreak ? 'white-space:pre-wrap;overflow-wrap:anywhere' : 'white-space:pre;width:max-content'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent}div{box-sizing:border-box;padding:8px 12px ${style.rowHeight}px;color:${style.foreground};font-family:monospace;font-size:${style.fontSize}px;line-height:${style.rowHeight / style.fontSize};tab-size:4;${wrap}}::selection{background:color-mix(in srgb,${style.selection} 32%,transparent)}</style></head><body><div>${text}</div></body></html>`
}

/**
 * Script for the page: copy writes plain text (Android pastes copied HTML as
 * styled text with collapsed whitespace), and the page scrolls to `line`.
 * Wrapped text reflows when the web view reaches its final width, so it
 * scrolls again on the first resize.
 */
export function selectableSourceScript(line: number): string {
  return `addEventListener("copy",(event)=>{event.clipboardData.setData("text/plain",getSelection().toString());event.preventDefault();});const line=document.getElementById("L${Math.max(1, Math.trunc(line))}");const reveal=()=>line?.scrollIntoView({block:"center"});reveal();addEventListener("resize",reveal,{once:true});true;`
}
