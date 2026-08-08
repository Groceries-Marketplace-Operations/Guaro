import { sleep } from '../queue/handlers/didi-food.util';

// DiDi applies this limit across the whole application, not per shop/token.
// Menu exports and menu uploads must therefore share the same in-process queue.
export const GROCERY_TASK_STATUS_MIN_INTERVAL_MS = 5_250;

let taskStatusTail = Promise.resolve();
let nextTaskStatusPollAt = 0;

export async function withGroceryTaskStatusRateLimit<T>(action: () => Promise<T>): Promise<T> {
  const scheduled = taskStatusTail.then(async () => {
    const waitMs = Math.max(0, nextTaskStatusPollAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextTaskStatusPollAt = Date.now() + GROCERY_TASK_STATUS_MIN_INTERVAL_MS;
    return action();
  });
  taskStatusTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}
