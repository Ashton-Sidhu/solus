/** One open gallery. Keep its order fixed while new reply images arrive. */
export class ImageGallery {
  readonly paths: readonly string[];
  index = $state(0);

  constructor(paths: readonly string[], openedPath: string) {
    const index = paths.indexOf(openedPath);
    this.paths = index < 0 ? [openedPath] : paths.slice();
    this.index = Math.max(0, index);
  }

  get path(): string { return this.paths[this.index]; }
  get hasPrevious(): boolean { return this.index > 0; }
  get hasNext(): boolean { return this.index < this.paths.length - 1; }

  previous(): void {
    if (this.hasPrevious) this.index--;
  }

  next(): void {
    if (this.hasNext) this.index++;
  }
}
