/**
 * The input overlay a recording shows, injected into the browser guest.
 *
 * A video of a UI shows what changed but not why: without it, a click or a key
 * press is invisible. The overlay draws a ripple at each pointer press and a
 * chip for each key press. It is in the guest, like the annotation overlay, so
 * input from the user, a phone, and an agent all reach it as ordinary events,
 * and the frames the recorder encodes contain it.
 *
 * Each mark animates once and removes itself; nothing repaints while the page
 * is idle. Keys typed into a password field show as dots.
 */

const GLOBAL = '__solusRecordingOverlay'
const HIGHLIGHT = 'rgb(217, 119, 87)'

/** Install the overlay (idempotent), or remove it. Returns a JSON string, as
 *  every guest expression does. */
export function recordingOverlayExpression(enabled: boolean): string {
  return `(() => {
  const existing = window[${JSON.stringify(GLOBAL)}];
  if (!${enabled}) {
    if (existing) existing.remove();
    return 'null';
  }
  if (existing) return 'null';
  const HIGHLIGHT = ${JSON.stringify(HIGHLIGHT)};
  const root = document.createElement('div');
  root.setAttribute('data-solus-recording-overlay', '');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
  const keys = document.createElement('div');
  keys.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:6px;';
  root.appendChild(keys);

  const onPointer = (event) => {
    const ripple = document.createElement('div');
    ripple.style.cssText = 'position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;'
      + 'border:3px solid ' + HIGHLIGHT + ';background:rgba(217,119,87,0.25);'
      + 'left:' + event.clientX + 'px;top:' + event.clientY + 'px;';
    root.appendChild(ripple);
    ripple.animate(
      [{ transform: 'scale(0.5)', opacity: 1 }, { transform: 'scale(1.8)', opacity: 0 }],
      { duration: 600, easing: 'ease-out' },
    ).onfinish = () => ripple.remove();
  };

  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
  let typing = null;
  const label = (event) => {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.metaKey) parts.push('Cmd');
    const printable = event.key.length === 1;
    if (event.shiftKey && !printable) parts.push('Shift');
    parts.push(event.key === ' ' ? 'Space' : event.key);
    return parts.join('+');
  };
  const fade = (chip) => {
    clearTimeout(chip.fadeTimer);
    chip.fadeTimer = setTimeout(() => {
      chip.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => {
        chip.remove();
        if (typing === chip) typing = null;
      };
    }, 1200);
  };
  const onKey = (event) => {
    if (MODIFIERS.has(event.key)) return;
    const target = event.target;
    const secret = target && target.type === 'password';
    const plain = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (plain && typing && typing.isConnected) {
      // Consecutive characters join one chip, so typing reads as a word
      // rather than a row of letters.
      typing.textContent = (typing.textContent + (secret ? '•' : event.key)).slice(-24);
      fade(typing);
      return;
    }
    const chip = document.createElement('div');
    chip.style.cssText = 'padding:4px 10px;border-radius:8px;background:rgba(20,20,20,0.85);color:#fff;'
      + 'font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;white-space:pre;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    chip.textContent = secret && plain ? '•' : label(event);
    keys.appendChild(chip);
    while (keys.children.length > 4) keys.firstChild.remove();
    typing = plain ? chip : null;
    fade(chip);
  };

  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('keydown', onKey, true);
  (document.body || document.documentElement).appendChild(root);
  window[${JSON.stringify(GLOBAL)}] = {
    remove() {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      delete window[${JSON.stringify(GLOBAL)}];
    },
  };
  return 'null';
})()`
}
