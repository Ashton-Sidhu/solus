/**
 * Whether the thread screen quarantines the keyboard state when Android
 * resumes the app (T3 Code #20803).
 *
 * Android can swallow the IME hide callbacks when the app is backgrounded
 * while the keyboard hides: send blurs the composer and starts the hide, then
 * Home. The keyboard library then reports the keyboard open, and the composer
 * would stay lifted over an empty space. Quarantine keeps it down until the
 * keyboard reports again.
 *
 * The composer that kept focus through the switch is exempt: Android restores
 * its keyboard unchanged and no event would end the quarantine, so the
 * composer would sit under the keyboard. Back hides the keyboard but keeps
 * focus, so a hide that started and did not finish still quarantines (Back,
 * then Home, during the hide).
 *
 * Every input is an event: the composer's focus and blur, the keyboard's
 * transitions, and the committed question state. Nothing is read from a
 * render.
 */
export class KeyboardResumeGuard {
  private composerFocused = false;
  /** A question hides the composer without unmounting it, so its blur may never come. */
  private questionShown = false;
  private keyboardHiding = false;

  composerFocusChanged(focused: boolean): void {
    this.composerFocused = focused;
  }

  questionShownChanged(shown: boolean): void {
    this.questionShown = shown;
  }

  keyboardEvent(event: "keyboardWillShow" | "keyboardWillHide" | "keyboardDidHide"): void {
    this.keyboardHiding = event === "keyboardWillHide";
  }

  /** On resume: whether the keyboard state must wait for the keyboard to report again. */
  suspectOnResume(): boolean {
    const composerOwnsKeyboard = this.composerFocused && !this.questionShown;
    return !composerOwnsKeyboard || this.keyboardHiding;
  }
}
