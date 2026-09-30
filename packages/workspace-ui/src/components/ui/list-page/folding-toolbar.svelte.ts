import { tick } from 'svelte'

/** How far the list scrolls before its narrowing row folds away. */
const FOLD_AFTER_PX = 48

/**
 * The folding header of a list page (`ListPage`'s `condensed`): scrolled past
 * the narrowing row, the row folds into the crumb line. It stays unfolded
 * while the search holds text or focus, and the crumb's search button unfolds
 * it on purpose until the field is left.
 *
 * Shared by the Pull Requests list and the Insights rail, so the two fold at
 * the same point and for the same reasons. The handlers are arrow fields so a
 * page can pass them straight to a component or a window listener.
 */
export class FoldingToolbar {
  private searchFocused = $state(false)
  private pinned = $state(false)
  private pointerHeld = false
  private foldAfterPress = false

  constructor(
    private readonly scrollTop: () => number,
    private readonly hasQuery: () => boolean,
    private readonly searchField: () => HTMLInputElement | null | undefined,
  ) {}

  get condensed(): boolean {
    return (
      this.scrollTop() > FOLD_AFTER_PX && !this.hasQuery() && !this.searchFocused && !this.pinned
    )
  }

  /** A press on a row blurs the field on pointerdown. Folding then moves the
   *  list under the pointer before the release, and the browser drops the
   *  click — so a blur during a press folds only once the press ends. */
  searchFocusChanged = (focused: boolean): void => {
    if (!focused && this.pointerHeld) {
      this.foldAfterPress = true
      return
    }
    this.foldAfterPress = false
    this.searchFocused = focused
    if (!focused) this.pinned = false
  }

  pressStarted = (): void => {
    this.pointerHeld = true
  }

  pressEnded = (): void => {
    this.pointerHeld = false
    if (this.foldAfterPress) this.searchFocusChanged(false)
  }

  /** The crumb's search button: unfold, then put the cursor in the field. */
  unfoldSearch = (): void => {
    this.pinned = true
    void tick().then(() => this.searchField()?.focus())
  }
}
