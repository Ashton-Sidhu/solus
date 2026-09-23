/**
 * The pull request list's search, as the page holds it. The field narrows what
 * is on screen as it is typed; the host is asked 250ms after typing stops,
 * through its own search, which reads more than a row shows (bodies,
 * comments). Clearing the field goes back to the listing at once.
 *
 * Constructed during a component's setup, since it owns the debounce effect.
 */
import { hostSearchQuery, parsePrSearchQuery } from './pr-search-query'

const SEARCH_DEBOUNCE_MS = 250

export class PrListSearch {
  /** The query last sent to the host. */
  private sent = $state('')

  /** The typed query, parsed — what the rows on screen are narrowed by. */
  readonly typed = $derived.by(() => parsePrSearchQuery(this.query()))
  /** The host query the typed text would send; equal to `hostQuery` once the
   *  debounce has passed. */
  readonly typedHostQuery = $derived.by(() => hostSearchQuery(this.typed))
  /** The host query the list reads with. Empty reads the ordinary listing. */
  readonly hostQuery = $derived.by(() => hostSearchQuery(parsePrSearchQuery(this.sent)))

  constructor(private readonly query: () => string) {
    this.sent = query()
    $effect(() => {
      const typed = this.query()
      if (!typed.trim()) {
        this.sent = ''
        return
      }
      const timer = setTimeout(() => (this.sent = typed), SEARCH_DEBOUNCE_MS)
      return () => clearTimeout(timer)
    })
  }
}
