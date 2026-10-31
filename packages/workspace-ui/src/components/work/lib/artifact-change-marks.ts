import { diffArrays } from 'diff'
import { z } from 'zod'

/** Which frame of an artifact comparison a page is: the older body or the newer one. */
export type ArtifactSide = 'before' | 'after'

/** A frame stops reporting past this many words; a diff past it costs more than it shows. */
const MAX_WORDS = 20_000

/**
 * Marks what changed between two artifact renders. An artifact is often a
 * script that builds its page, so the comparison reads the words each frame
 * shows after it runs, not its markup. Each frame reports its words; the
 * dialog diffs them and sends back the indexes to mark. The frame paints them
 * with the CSS Custom Highlight API, which does not touch the DOM, so a page
 * that re-renders keeps working. A re-render reports again and the marks follow.
 */
export function withChangeMarks(html: string, channel: string, side: ArtifactSide): string {
  // A light tint and a heavy line: the line reads on any fill, so a mark on a
  // coloured button stays legible where a solid fill turned muddy.
  const style = side === 'after'
    ? 'background-color:rgba(46,160,67,.16);text-decoration:underline 2px rgb(46,160,67)'
    : 'background-color:rgba(248,81,73,.14);text-decoration:line-through 2px rgb(229,72,77)'
  return `${html}<script>(()=>{
const C=${JSON.stringify(channel)},S=${JSON.stringify(side)},MAX=${MAX_WORDS};let spans=[],timer=0;
const s=document.createElement("style");s.textContent="::highlight(solus-history-change){${style}}";(document.head||document.documentElement).appendChild(s);
function read(){const words=[];spans=[];if(!document.body)return words;
const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement&&n.parentElement.closest("script,style,noscript,template")?2:1});
for(let n=w.nextNode();n&&words.length<MAX;n=w.nextNode()){const re=/\\S+/g;for(let m=re.exec(n.data);m&&words.length<MAX;m=re.exec(n.data)){words.push(m[0]);spans.push([n,m.index,m.index+m[0].length])}}return words}
function report(){clearTimeout(timer);timer=setTimeout(()=>parent.postMessage({type:"solus-history-words",channel:C,side:S,words:read()},"*"),150)}
addEventListener("message",e=>{const d=e.data;if(e.source!==parent||!d||d.type!=="solus-history-marks"||d.channel!==C||!window.CSS||!CSS.highlights)return;
const h=new Highlight();let r=null,node=null,last=-2;
for(const i of d.indexes){const x=spans[i];if(!x||!x[0].isConnected)continue;if(r&&x[0]===node&&i===last+1)r.setEnd(node,x[2]);else{r=new Range();node=x[0];r.setStart(node,x[1]);r.setEnd(node,x[2]);h.add(r)}last=i}
CSS.highlights.set("solus-history-change",h)});
function start(){report();new MutationObserver(report).observe(document.body,{subtree:true,childList:true,characterData:true})}
document.readyState==="loading"?addEventListener("DOMContentLoaded",start):start()})()</script>`
}

/** The word indexes each side should mark: words only the older body shows, and words only the newer one shows. */
export interface ChangedWords {
  before: number[]
  after: number[]
}

export function changedWords(before: string[], after: string[]): ChangedWords | null {
  const changes = diffArrays(before, after, { timeout: 250 })
  if (!changes) return null
  const marks: ChangedWords = { before: [], after: [] }
  let beforeIndex = 0
  let afterIndex = 0
  for (const change of changes) {
    for (let k = 0; k < change.count; k++) {
      if (change.removed) marks.before.push(beforeIndex++)
      else if (change.added) marks.after.push(afterIndex++)
      else {
        beforeIndex++
        afterIndex++
      }
    }
  }
  return marks
}

const wordsMessageSchema = z.object({
  type: z.literal('solus-history-words'),
  channel: z.string(),
  side: z.enum(['before', 'after']),
  words: z.array(z.string()).max(MAX_WORDS),
})

/** The dialog's half of the exchange for one comparison. `channel` names the
 *  comparison, so a frame of an earlier comparison is not heard. */
export class ArtifactChangeMarks {
  readonly #channel: string
  readonly #reports = new Map<ArtifactSide, { words: string[]; frame: MessageEventSource }>()
  #enabled: boolean

  constructor(channel: string, enabled: boolean) {
    this.#channel = channel
    this.#enabled = enabled
  }

  receive(event: Pick<MessageEvent, 'data' | 'source'>): void {
    const parsed = wordsMessageSchema.safeParse(event.data)
    if (!parsed.success || parsed.data.channel !== this.#channel || !event.source) return
    this.#reports.set(parsed.data.side, { words: parsed.data.words, frame: event.source })
    this.#send()
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    this.#send()
  }

  #send(): void {
    const before = this.#reports.get('before')
    const after = this.#reports.get('after')
    if (!before || !after) return
    const marks = this.#enabled ? changedWords(before.words, after.words) : null
    for (const side of ['before', 'after'] as const) {
      const frame = side === 'before' ? before.frame : after.frame
      frame.postMessage({ type: 'solus-history-marks', channel: this.#channel, indexes: marks?.[side] ?? [] }, { targetOrigin: '*' })
    }
  }
}
