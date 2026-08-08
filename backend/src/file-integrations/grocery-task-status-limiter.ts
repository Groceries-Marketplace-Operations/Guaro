import { sleep } from '../queue/handlers/didi-food.util';

// DiDi applies this limit across the whole application, not per shop/token.
// Menu exports and menu uploads must therefore share the same in-process queue.
export const GROCERY_TASK_STATUS_MIN_INTERVAL_MS = 5_250;

interface StatusLane {
  tail: Promise<void>;
  nextPollAt: number;
}

const lanes = new Map<string, StatusLane>();

export async function withGroceryTaskStatusRateLimit<T>(
  action: () => Promise<T>,
  applicationKey = 'global',
): Promise<T> {
  const lane = lanes.get(applicationKey) ?? { tail: Promise.resolve(), nextPollAt: 0 };
  lanes.set(applicationKey, lane);
  const scheduled = lane.tail.then(async () => {
    const waitMs = Math.max(0, lane.nextPollAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lane.nextPollAt = Date.now() + GROCERY_TASK_STATUS_MIN_INTERVAL_MS;
    return action();
  });
  lane.tail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}
