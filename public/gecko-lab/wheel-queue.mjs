// A busy page can leave old touchpad updates queued ahead of a reversal.
// Combine only adjacent, compatible pixel-mode updates that are still waiting;
// never combine opposite directions, modifiers, coordinates, or line/page input.
export function optimizeWheelQueue(gecko, canvas, now = () => performance.now()) {
  let currentWheel;
  canvas.addEventListener('wheel', event => {
    const token = {
      eligible: event.deltaMode === 0 && !event.ctrlKey && !event.altKey &&
        !event.metaKey && !event.shiftKey && Math.abs(event.deltaX) <= 32 &&
        Math.abs(event.deltaY) <= 32 && (event.deltaX !== 0 || event.deltaY !== 0),
    };
    currentWheel = token;
    queueMicrotask(() => { if (currentWheel === token) currentWheel = undefined; });
  }, { capture: true, passive: true });
  const run = gecko.run.bind(gecko);
  const compatible = (a, b) => a === 0 || b === 0 || Math.sign(a) === Math.sign(b);
  gecko.run = item => {
    if (item.op !== 3) return run(item);
    item.outpostCoalescible = Boolean(currentWheel?.eligible);
    item.outpostQueuedAt = now();
    const previous = gecko.queue[gecko.queue.length - 1];
    if (item.outpostCoalescible && previous?.op === 3 && previous.outpostCoalescible &&
        previous.x === item.x && previous.y === item.y && previous.modifiers === item.modifiers) {
      // When direction reverses, combine the waiting old-direction updates so
      // they cannot hold the new gesture behind many separate page callbacks.
      const px = previous.deltaX || 0, py = previous.deltaY || 0;
      const ix = item.deltaX || 0, iy = item.deltaY || 0;
      if (!compatible(px, ix) || !compatible(py, iy)) {
        let first = gecko.queue.length - 1, sumX = px, sumY = py;
        while (first > 0) {
          const candidate = gecko.queue[first - 1];
          const cx = candidate.deltaX || 0, cy = candidate.deltaY || 0;
          if (candidate.op !== 3 || !candidate.outpostCoalescible || candidate.x !== item.x ||
              candidate.y !== item.y || candidate.modifiers !== item.modifiers ||
              !compatible(sumX, cx) || !compatible(sumY, cy) ||
              Math.abs(sumX + cx) > 256 || Math.abs(sumY + cy) > 256) break;
          sumX += cx; sumY += cy; first--;
        }
        if (first < gecko.queue.length - 1) {
          const combined = gecko.queue[first];
          combined.deltaX = sumX; combined.deltaY = sumY;
          for (const removed of gecko.queue.splice(first + 1)) removed.resolve?.(0);
        }
        return run(item);
      }
      let oldest = previous;
      let pending = 1;
      for (let i = gecko.queue.length - 2; i >= 0 && gecko.queue[i].op === 3 && gecko.queue[i].outpostCoalescible; i--) {
        oldest = gecko.queue[i];
        pending++;
      }
      const ax = previous.deltaX || 0, ay = previous.deltaY || 0;
      const bx = item.deltaX || 0, by = item.deltaY || 0;
      if ((pending >= 2 || item.outpostQueuedAt - oldest.outpostQueuedAt >= 8) && compatible(ax, bx) && compatible(ay, by) &&
          Math.abs(ax + bx) <= 128 && Math.abs(ay + by) <= 128) {
        previous.deltaX = ax + bx;
        previous.deltaY = ay + by;
        return Promise.resolve(0);
      }
    }
    return run(item);
  };
}
