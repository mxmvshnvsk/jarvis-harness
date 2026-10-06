/**
 * Server-sent events of an OpenAI-compatible stream (`stream: true`): the `data:` payloads in
 * order. Comments (`: keep-alive`) and the `event:`/`id:`/`retry:` fields are not used by chat
 * completions and are skipped; a payload split across network chunks is joined.
 */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const take = (line: string): string | undefined => {
    if (line === "") {
      if (data.length === 0) return undefined;
      const payload = data.join("\n");
      data = [];
      return payload;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    return undefined;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const payload = take(line);
      if (payload !== undefined) yield payload;
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    const payload = take(line);
    if (payload !== undefined) yield payload;
  }
  const rest = take("");
  if (rest !== undefined) yield rest;
}
