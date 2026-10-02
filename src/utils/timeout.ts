/**
 * Race a promise against a deadline, ALWAYS clearing the timer.
 *
 * The timer is the reason this is a helper rather than an inline
 * `Promise.race([p, new Promise((_, rej) => setTimeout(rej, ms))])`: that form
 * leaves the timer armed after a fast success, holding the event loop open
 * until it fires. Several call sites had their own copy of exactly that.
 *
 * What it does NOT do is cancel the underlying work. A timed-out operation
 * keeps running; whoever owns the resource behind it has to close it. See the
 * MQTT exporter, which owns its client from creation for that reason.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
