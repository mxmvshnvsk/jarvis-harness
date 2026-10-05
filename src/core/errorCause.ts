/**
 * The `cause` chain of an error as text. `fetch` in Node fails with a bare `TypeError: fetch failed`;
 * what went wrong (DNS, refused connection, an untrusted corporate CA) is only in the nested causes,
 * and an `AggregateError` there carries one error per address tried.
 */
export interface CauseLink {
  readonly code?: string;
  readonly message: string;
}

const MAX_DEPTH = 6;

function linkOf(value: unknown): CauseLink {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0
      ? { code, message: value.message }
      : { message: value.message || value.name };
  }
  return { message: String(value) };
}

/** The causes below `error`, outermost first; `error` itself is not included. */
export function causeChain(error: unknown): CauseLink[] {
  const links: CauseLink[] = [];
  let current: unknown = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  while (current !== undefined && current !== null && links.length < MAX_DEPTH) {
    if (current instanceof AggregateError && current.errors.length > 0 && !current.message) {
      current = current.errors[0];
      continue;
    }
    links.push(linkOf(current));
    const next: unknown =
      current instanceof AggregateError && current.errors.length > 0
        ? current.errors[0]
        : current instanceof Error
          ? (current as { cause?: unknown }).cause
          : undefined;
    current = next;
  }
  return links;
}

export function formatLink(link: CauseLink): string {
  if (!link.code) return link.message;
  return link.message.includes(link.code) ? link.message : `${link.code}: ${link.message}`;
}

/** `a ← b ← c` for logs; undefined when there is no cause. */
export function describeCauses(error: unknown): string | undefined {
  const links = causeChain(error);
  return links.length > 0 ? links.map(formatLink).join(" ← ") : undefined;
}

/** The innermost cause — usually the one that names the real problem. */
export function rootCause(error: unknown): CauseLink | undefined {
  const links = causeChain(error);
  return links[links.length - 1];
}
