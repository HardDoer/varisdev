import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRenderScheduler} from '../assets/dashboard/render-scheduler.js';

void test('snapshot bursts paint the latest state once and resume after being hidden', () => {
  let hidden = false;
  let state = 0;
  let sequence = 0;
  const frames = new Map<number, () => void>();
  const rendered: number[] = [];
  const scheduler = createRenderScheduler(() => rendered.push(state), {
    requestFrame(callback: () => void) {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelFrame(frame: number) {
      frames.delete(frame);
    },
    isHidden: () => hidden,
  });
  const paint = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  for (state = 1; state <= 1000; state++) scheduler.schedule();
  state = 1000;
  assert.equal(frames.size, 1);
  paint();
  assert.deepEqual(rendered, [1000]);
  scheduler.schedule();
  hidden = true;
  scheduler.visibilityChanged();
  assert.equal(frames.size, 0);
  for (state = 1001; state <= 2000; state++) scheduler.schedule();
  state = 2000;
  assert.equal(frames.size, 0);
  hidden = false;
  scheduler.visibilityChanged();
  assert.equal(frames.size, 1);
  paint();
  assert.deepEqual(rendered, [1000, 2000]);

  scheduler.schedule();
  scheduler.rendered(); // A synchronous user action already rendered the state.
  assert.equal(frames.size, 0);
  scheduler.schedule();
  scheduler.dispose();
  scheduler.schedule();
  scheduler.visibilityChanged();
  paint();
  assert.deepEqual(rendered, [1000, 2000]);
});
