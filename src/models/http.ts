/**
 * Node's `fetch` (undici) gives up on a response whose headers take longer than 300 s
 * (`UND_ERR_HEADERS_TIMEOUT`), whatever the caller's own timeout. A reasoning model behind a
 * non-streaming gateway sends nothing until it is done, so a long answer failed at exactly 5:00
 * and was retried from scratch (pilot: two attempts of the requirements step, ten minutes lost,
 * read as "the gateway cuts at five minutes").
 *
 * For a model with a longer `timeoutMs` the request gets its own dispatcher with header and body
 * timeouts raised to it; the call's AbortSignal still enforces `timeoutMs`. The dispatcher is the
 * class of Node's own global one, so there is no extra dependency and no version mismatch with the
 * bundled undici.
 */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/** undici's default `headersTimeout` / `bodyTimeout`. */
export const FETCH_DEFAULT_TIMEOUT_MS = 300_000;

type DispatcherClass = new (options: { headersTimeout: number; bodyTimeout: number }) => unknown;

const byTimeout = new Map<number, unknown>();

async function dispatcherClass(): Promise<DispatcherClass | undefined> {
  const holder = globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>;
  if (!holder[GLOBAL_DISPATCHER]) {
    // the global dispatcher is created by the first fetch; an aborted one creates it without I/O
    await fetch("http://127.0.0.1/", { signal: AbortSignal.abort() }).catch(() => undefined);
  }
  const ctor = holder[GLOBAL_DISPATCHER]?.constructor;
  return typeof ctor === "function" ? (ctor as DispatcherClass) : undefined;
}

/** A dispatcher for requests allowed to run `timeoutMs`; undefined when the default is enough. */
export async function dispatcherFor(timeoutMs: number): Promise<unknown | undefined> {
  if (timeoutMs <= FETCH_DEFAULT_TIMEOUT_MS) return undefined;
  const cached = byTimeout.get(timeoutMs);
  if (cached) return cached;
  const Ctor = await dispatcherClass();
  if (!Ctor) return undefined;
  // a little past the call's own timeout: the AbortSignal, with its clear message, fires first
  const limit = timeoutMs + 5_000;
  const dispatcher = new Ctor({ headersTimeout: limit, bodyTimeout: limit });
  byTimeout.set(timeoutMs, dispatcher);
  return dispatcher;
}
