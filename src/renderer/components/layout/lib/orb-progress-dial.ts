/**
 * Font size for the "3/8" count inside the orb's circular dial.
 *
 * In compact and pill mode the dial is the whole button (2.25rem) and the ring
 * eats the outer edge, so the text has roughly 70% of that width. A fixed size
 * overflows as soon as the counts reach two digits, so scale to the widest
 * fraction the session can produce and keep it stable for the whole run.
 */
const DIAL_TEXT_WIDTH_REM = 1.55;
const DIGIT_ADVANCE_EM = 0.6;
const SEPARATOR_ADVANCE_EM = 0.42;
const MAX_FONT_REM = 0.75;

export function dialCountFontRem(
  currentStep: number,
  totalSteps: number,
): number {
  const digits = `${currentStep}`.length + `${totalSteps}`.length;
  const widthEm = digits * DIGIT_ADVANCE_EM + SEPARATOR_ADVANCE_EM;
  return Math.min(MAX_FONT_REM, DIAL_TEXT_WIDTH_REM / widthEm);
}
