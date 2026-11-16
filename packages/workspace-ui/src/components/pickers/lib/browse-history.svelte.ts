/** The folders one picker session showed, in order, for its Back and Forward buttons. */
export class BrowseHistory {
  #visited = $state<string[]>([]);
  #position = $state(-1);

  get canGoBack(): boolean {
    return this.#position > 0;
  }

  get canGoForward(): boolean {
    return this.#position < this.#visited.length - 1;
  }

  /** Starts a session at `directory` with nothing behind it. */
  reset(directory: string): void {
    this.#visited.splice(0, this.#visited.length, directory);
    this.#position = 0;
  }

  /** Records a folder the user went to. A new visit drops the folders ahead. */
  visit(directory: string): void {
    if (directory === this.#visited[this.#position]) return;
    this.#visited.splice(this.#position + 1, this.#visited.length, directory);
    this.#position = this.#visited.length - 1;
  }

  /** The folder before this one, or null at the start. */
  back(): string | null {
    if (!this.canGoBack) return null;
    this.#position -= 1;
    return this.#visited[this.#position];
  }

  /** The folder the last Back left, or null at the end. */
  forward(): string | null {
    if (!this.canGoForward) return null;
    this.#position += 1;
    return this.#visited[this.#position];
  }
}
