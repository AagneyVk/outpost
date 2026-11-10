// Keep a pressed mouse attached to the Gecko surface until it is released.
// A page drag must end even if the pointer leaves the canvas or the window.
export function captureDrag(canvas) {
  let buttons = 0;
  let last = { clientX: 0, clientY: 0 };
  const remember = event => {
    buttons = event.buttons;
    last = { clientX: event.clientX, clientY: event.clientY,
      altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey };
  };
  const forward = (type, event) => {
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY,
      button: event.button, buttons: event.buttons, detail: event.detail,
      altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
    }));
  };
  const release = () => {
    // MouseEvent.buttons uses a different order from MouseEvent.button.
    for (const [mask, button] of [[1, 0], [2, 2], [4, 1], [8, 3], [16, 4]]) {
      if (!(buttons & mask)) continue;
      buttons &= ~mask;
      forward('mouseup', { ...last, button, buttons, detail: 1 });
    }
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Window listeners below provide a fallback. */ }
  });
  canvas.addEventListener('mousedown', remember, true);
  canvas.addEventListener('mousemove', remember, true);
  canvas.addEventListener('mouseup', remember, true);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dragstart', event => event.preventDefault());
  window.addEventListener('mousemove', event => {
    if (buttons && event.target !== canvas) forward('mousemove', event);
  }, true);
  window.addEventListener('mouseup', event => {
    if (buttons && event.target !== canvas) forward('mouseup', event);
  }, true);
  window.addEventListener('blur', release);
}
