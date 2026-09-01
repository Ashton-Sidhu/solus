import { Marked, Renderer, type Tokens } from 'marked'
import { parseDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { DocDiagramAsset } from '@solus/contracts/docs'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? value : null
  } catch {
    return null
  }
}

class GoogleDocRenderer extends Renderer {
  override html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(text)
  }

  override link({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens)
    const safe = safeHref(href)
    if (!safe) return label
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${escapeHtml(safe)}"${titleAttribute}>${label}</a>`
  }

  override image({ href, title, text }: Tokens.Image): string {
    const safe = safeHref(href)
    if (!safe) return escapeHtml(text)
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttribute}>`
  }
}

function diagramFigure(asset: DocDiagramAsset): string {
  return `<figure><img src="data:${asset.mimeType};base64,${asset.base64}" alt="${escapeHtml(asset.title)}"><figcaption>${escapeHtml(asset.title)}</figcaption></figure>`
}

export async function buildGoogleDocHtml(markdown: string, assets: DocDiagramAsset[]): Promise<string> {
  const byWorkId = new Map(assets.map((asset) => [asset.workId, asset]))
  const marked = new Marked()
  marked.setOptions({ gfm: true, renderer: new GoogleDocRenderer() })
  const body: string[] = []
  let markdownLines: string[] = []

  const flushMarkdown = async () => {
    if (markdownLines.length === 0) return
    body.push(String(await marked.parse(markdownLines.join('\n'))))
    markdownLines = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const reference = parseDiagramEmbed(line)
    if (!reference) {
      markdownLines.push(line)
      continue
    }
    await flushMarkdown()
    const asset = byWorkId.get(reference.workId)
    if (!asset) throw new Error(`Diagram “${reference.title}” was not prepared for upload.`)
    body.push(diagramFigure(asset))
  }
  await flushMarkdown()

  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#292622;line-height:1.55}h1,h2,h3{color:#292622}pre{white-space:pre-wrap;background:#f6f4f1;padding:12px;border-radius:8px}code{font-family:monospace}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8d3cc;padding:6px 8px;text-align:left}figure{margin:24px 0;text-align:center;page-break-inside:avoid}figure img{display:block;max-width:100%;height:auto;margin:0 auto}figcaption{margin-top:8px;color:#77716a;font-size:12px}</style></head><body>${body.join('\n')}</body></html>`
}
