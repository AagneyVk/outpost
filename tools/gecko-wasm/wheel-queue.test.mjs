import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeWheelQueue } from '../../public/gecko-lab/wheel-queue.mjs';

function fixture() {
  const canvas = new EventTarget();
  const gecko = { queue: [], run(item) { this.queue.push(item); return Promise.resolve(); } };
  let now = 0;
  optimizeWheelQueue(gecko, canvas, () => now);
  canvas.addEventListener('wheel', event => gecko.run({ op: 3, x: event.x, y: event.y,
    deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.ctrlKey ? 2 : 0 }));
  function wheel(options = {}) {
    const event = new Event('wheel');
    const { advance = 0, ...properties } = options;
    now += advance;
    Object.assign(event, { deltaMode: 0, deltaX: 0, deltaY: 1, x: 10, y: 20,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, properties);
    canvas.dispatchEvent(event);
  }
  return { gecko, wheel };
}

test('combines waiting same-direction pixel deltas without losing distance', () => {
  const { gecko, wheel } = fixture();
  wheel({ deltaY: 0.4 });
  wheel({ deltaY: 0.4, advance: 25 });
  for (let i = 0; i < 3; i++) wheel({ deltaY: 0.4 });
  assert.equal(gecko.queue.length, 1);
  assert.equal(gecko.queue[0].deltaY, 2);
});

test('preserves individual updates while the queue is fresh', () => {
  const { gecko, wheel } = fixture();
  for (let i = 0; i < 2; i++) wheel({ deltaY: 1, advance: 2 });
  assert.equal(gecko.queue.length, 2);
});

test('keeps reversals, targets, modifiers, and line-mode events distinct', () => {
  const { gecko, wheel } = fixture();
  wheel({ deltaY: -2 });
  wheel({ deltaY: 2 });
  wheel({ deltaY: 2, x: 11 });
  wheel({ deltaY: 2, ctrlKey: true });
  wheel({ deltaY: 2, deltaMode: 1 });
  assert.equal(gecko.queue.length, 5);
  assert.deepEqual(gecko.queue.map(item => item.deltaY), [-2, 2, 2, 2, 2]);
});

test('a reversal collapses only compatible waiting movement and preserves distance', () => {
  const { gecko, wheel } = fixture();
  for (let i = 0; i < 20; i++) wheel({ deltaY: -10 });
  wheel({ deltaY: 5 });
  assert.deepEqual(gecko.queue.map(item => item.deltaY), [-200, 5]);
});

test('reversal consolidation does not cross a keyboard event', () => {
  const { gecko, wheel } = fixture();
  wheel({ deltaY: -10 });
  gecko.run({ op: 2 });
  for (let i = 0; i < 5; i++) wheel({ deltaY: -10 });
  wheel({ deltaY: 5 });
  assert.deepEqual(gecko.queue.map(item => item.op), [3, 2, 3, 3]);
  assert.equal(gecko.queue[2].deltaY, -50);
});

test('reversal consolidation respects its size and target boundaries', () => {
  const { gecko, wheel } = fixture();
  wheel({ deltaY: -10, x: 11 });
  for (let i = 0; i < 80; i++) wheel({ deltaY: -10 });
  wheel({ deltaY: 5 });
  assert.equal(gecko.queue[0].x, 11);
  assert(gecko.queue.every(item => Math.abs(item.deltaY) <= 256));
  assert.equal(gecko.queue.reduce((sum, item) => sum + item.deltaY, 0), -805);
  assert.equal(gecko.queue.at(-1).deltaY, 5);
});

test('normal batches do not cross another command or exceed their size limit', () => {
  const { gecko, wheel } = fixture();
  wheel({ deltaY: 10 });
  gecko.run({ op: 2 });
  wheel({ deltaY: 10 });
  assert.equal(gecko.queue.length, 3);
  for (let i = 0; i < 205; i++) wheel({ deltaY: 10 });
  assert(gecko.queue.every(item => item.op !== 3 || item.deltaY <= 128));
  assert.equal(gecko.queue.filter(item => item.op === 3).reduce((sum, item) => sum + item.deltaY, 0), 2070);
});
