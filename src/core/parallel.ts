import { log } from "./errors.js";

export const MAX_CONCURRENT = 4;

/**
 * Run tasks with at most MAX_CONCURRENT in flight, settling each (never rejecting the batch).
 * Callers surface partial results with a clear signal of what's missing rather than failing the whole readout.
 */
export async function settleLimit<T>(traceId: string, tasks: Array<() => Promise<T>>, limit = MAX_CONCURRENT): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length > limit) log("fanout.cap_engaged", { traceId, tasks: tasks.length, limit });
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
