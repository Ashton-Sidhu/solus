type TouchIdentifier = string | number;

/** A physical press belongs to the action and session where its touch began. */
export class ComposerActionTouch {
  private touch: { actionKey: string; identifier: TouchIdentifier } | null = null;

  begin(actionKey: string, identifier: TouchIdentifier): void {
    this.touch = { actionKey, identifier };
  }

  cancel(): void {
    this.touch = null;
  }

  accept(actionKey: string, identifier: TouchIdentifier | undefined): boolean {
    // Accessibility activation has no physical touch sequence.
    if (identifier === undefined) return true;
    const touch = this.touch;
    this.touch = null;
    return touch !== null && touch.actionKey === actionKey && touch.identifier === identifier;
  }
}
