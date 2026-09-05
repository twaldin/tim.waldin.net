'use strict';

/**
 * Date.now-compatible clock with its own timer queue, injectable into Admission
 * as `clock`. `advance(ms)` runs every timer due within the window in order.
 */
function makeFakeClock(start = 0) {
  let now = start;
  let nextTimerId = 1;
  const timers = new Map();

  const clock = () => now;
  clock.setTimeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  clock.clearTimeout = (id) => timers.delete(id);
  clock.advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;

      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      await timer.callback();
    }
    now = target;
  };

  return clock;
}

module.exports = { makeFakeClock };
