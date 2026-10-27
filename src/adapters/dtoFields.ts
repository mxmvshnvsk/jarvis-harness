import { blankLiterals } from "./java/source.ts";

/**
 * The fields of a contract's DTOs (ADR-0025 §6), read without a compiler from Java, Kotlin and
 * TypeScript sources, and the two sides of a contract compared field by field. Only where the type is
 * declared: `@KafkaListener void on(OrderCreatedEvent e)`, `KafkaTemplate<String, OrderCreatedEvent>`,
 * `ResponseEntity<SlotDto>`, `@RequestBody CreateOrder body`. A type that is not seen
 * (`KafkaTemplate<String, Object>`, a `String` from `writeValueAsString`) leaves the fields unchecked,
 * never failed. The name on the wire is the JSON one: `@JsonProperty("slot_id")` renames a field,
 * `@JsonIgnore` drops it; with Lombok (`@Data`, `@Value`, `@Getter`) the fields are the properties.
 */
export interface DtoField {
  /** The name on the wire. */
  readonly name: string;
  /** The field's name in the code, when `@JsonProperty` gives it another on the wire. */
  readonly code?: string;
  /** The type as the code writes it. */
  readonly type: string;
  readonly line: number;
}

export interface DtoDecl {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly fields: readonly DtoField[];
}

export type FieldChange = "same" | "added" | "removed" | "renamed" | "type changed";

/** One field of a DTO as the writer (who serializes it) and the reader (who reads it) have it. */
export interface FieldRow {
  readonly field: string;
  readonly change: FieldChange;
  readonly status: "ok" | "mismatch";
  /** `name: type` on each side, where the side has it. */
  readonly writer?: string;
  readonly reader?: string;
}

const JVM = /\.(java|kt|kts|groovy)$/;
const TS = /\.(ts|tsx|mts|cts)$/;

/** Is this a source file whose DTOs can be read? */
export const isDtoSource = (file: string): boolean =>
  (JVM.test(file) || TS.test(file)) && !/\.d\.ts$/.test(file);

/** The index just past the bracket that closes the one at `open` (`{`, `(`, `<`), or the end. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "<": ">", "[": "]" };
  const o = code[open] as string;
  const c = pairs[o] as string;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === o) depth += 1;
    else if (ch === c) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/** Splits at the commas outside brackets (parameters, generic arguments). */
function topLevel(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
    } else if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

const ANNOTATION = /@[\w.:]+(\s*\((?:[^()]|\([^()]*\))*\))?/g;

/** A declaration's annotations: the JSON name it is given, and whether it is left out. */
function jsonOf(text: string): { name?: string; ignored: boolean } {
  const named =
    /@(?:field:|get:|param:)?(?:JsonProperty|SerializedName|JsonAlias)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/.exec(
      text,
    )?.[1];
  const ignored = /@(?:field:|get:)?(?:JsonIgnore|Transient)\b(?!Properties)/.test(text);
  return { ...(named ? { name: named } : {}), ignored };
}

/** `private final List<String> items = new ArrayList<>()` → its type and name. */
function javaMember(statement: string): { type: string; name: string } | undefined {
  const s = statement
    .replace(ANNOTATION, " ")
    .replace(/=[\s\S]*$/, "")
    .replace(/\b(public|protected|private|final|transient|volatile)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || /\bstatic\b/.test(s) || /[()]/.test(s)) return undefined;
  const m = /^([\w.$]+(?:\s*<[\s\S]*>)?(?:\s*\[\s*\])*)\s+(\w+)$/.exec(s);
  return m ? { type: (m[1] as string).replace(/\s+/g, ""), name: m[2] as string } : undefined;
}

/** `@JsonProperty("slot_id") val slotId: Long? = null` → its type and name (a Kotlin parameter or property). */
function kotlinMember(statement: string): { type: string; name: string } | undefined {
  const s = statement
    .replace(ANNOTATION, " ")
    .replace(/=[\s\S]*$/, "")
    .replace(/\b(private|protected|public|internal|override|open|lateinit)\b/g, " ")
    .trim();
  const m = /^(?:val|var)\s+(\w+)\s*:\s*([\s\S]+)$/.exec(s);
  return m ? { name: m[1] as string, type: (m[2] as string).replace(/\s+/g, "") } : undefined;
}

/** `readonly slotId?: string` → its type and name (a TypeScript member). */
function tsMember(statement: string): { type: string; name: string } | undefined {
  const s = statement
    .replace(ANNOTATION, " ")
    .replace(/\b(public|protected|private|readonly|declare)\b/g, " ")
    .trim();
  const m = /^["']?([\w$]+)["']?\s*[?!]?\s*:\s*([\s\S]+?)\s*(?:=[\s\S]*)?$/.exec(s);
  if (!m || /^\(/.test((m[2] as string).trim())) return undefined;
  return { name: m[1] as string, type: (m[2] as string).replace(/\s+/g, "") };
}

/** The statements of a class body at its own level: fields, not methods' bodies or nested types. */
function bodyStatements(
  code: string,
  from: number,
  to: number,
  ts: boolean,
): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let start = from;
  for (let i = from; i < to; i += 1) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < to && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
    } else if (ch === "(" || ch === "<" || ch === "[") {
      i = closing(code, i) - 1;
    } else if (ch === "{") {
      // a method's body, an initializer, a nested type — or a TypeScript member's object type
      const end = closing(code, i);
      const head = code.slice(start, i);
      if (ts && /:\s*$/.test(head)) {
        i = end - 1;
        continue;
      }
      start = end;
      i = end - 1;
    } else if (ch === ";" || (ts && (ch === "," || ch === "\n"))) {
      const text = code.slice(start, i);
      if (text.trim()) out.push({ text, at: start + (text.length - text.trimStart().length) });
      start = i + 1;
    }
  }
  const rest = code.slice(start, to);
  if (rest.trim()) out.push({ text: rest, at: start + (rest.length - rest.trimStart().length) });
  return out;
}

const JVM_DECL = /\b(?:(data|value)\s+)?(class|record|interface|enum)\s+([A-Z]\w*)\s*(<[^>{(]*>)?\s*(\()?/g;
const TS_DECL =
  /\b(?:(interface|class)\s+([A-Z]\w*)\s*(?:<[^>{]*>)?[^{=;]*\{|type\s+([A-Z]\w*)\s*(?:<[^>=]*>)?\s*=\s*\{)/g;

/** The DTOs a source file declares, with their fields. */
export function dtoDeclsOf(file: string, content: string): DtoDecl[] {
  if (!isDtoSource(file)) return [];
  const code = blankLiterals(content, true);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const out: DtoDecl[] = [];
  const add = (
    name: string,
    at: number,
    members: Array<{ text: string; at: number }>,
    parse: (s: string) => { type: string; name: string } | undefined,
  ) => {
    const fields: DtoField[] = [];
    for (const m of members) {
      const json = jsonOf(m.text);
      const member = parse(m.text);
      if (!member || json.ignored) continue;
      if (fields.some((f) => f.name === (json.name ?? member.name))) continue;
      fields.push({
        name: json.name ?? member.name,
        ...(json.name && json.name !== member.name ? { code: member.name } : {}),
        type: member.type,
        line: lineAt(m.at),
      });
    }
    out.push({ name, file, line: lineAt(at), fields });
  };
  if (TS.test(file)) {
    for (const m of code.matchAll(TS_DECL)) {
      const at = m.index ?? 0;
      const open = at + m[0].length - 1;
      const end = closing(code, open);
      add((m[2] ?? m[3]) as string, at, bodyStatements(code, open + 1, end - 1, true), tsMember);
    }
    return out;
  }
  const kotlin = /\.kts?$/.test(file);
  for (const m of code.matchAll(JVM_DECL)) {
    const kind = m[2] as string;
    if (kind === "interface") continue;
    const at = m.index ?? 0;
    // an enum: its constants are what goes between the sides (pilot: a value removed from a shared
    // enum, and the check said the type was not declared in the library declaring it)
    if (kind === "enum") {
      const open = code.indexOf("{", at + m[0].length - 1);
      if (open < 0) continue;
      const end = closing(code, open);
      const body = code.slice(open + 1, end - 1);
      const head = body.split(";")[0] ?? "";
      const fields: DtoField[] = [];
      let from = open + 1;
      for (const part of topLevel(head)) {
        const name = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*([A-Z_][A-Z0-9_]*)\b/.exec(part)?.[1];
        const idx = code.indexOf(part, from);
        from = idx < 0 ? from : idx + part.length;
        if (name && !fields.some((f) => f.name === name))
          fields.push({ name, type: "enum constant", line: lineAt(idx < 0 ? open : idx) });
      }
      out.push({ name: m[3] as string, file, line: lineAt(at), fields });
      continue;
    }
    const name = m[3] as string;
    let members: Array<{ text: string; at: number }> = [];
    let after = at + m[0].length;
    if (m[5]) {
      // a record's components, a Kotlin class's constructor properties
      const open = after - 1;
      const end = closing(code, open);
      let from = open + 1;
      for (const part of topLevel(code.slice(open + 1, end - 1))) {
        const idx = code.indexOf(part, from);
        members.push({ text: part, at: idx < 0 ? open : idx });
        from = idx < 0 ? from : idx + part.length;
      }
      after = end;
    }
    // the body, if the type has one: after its constructor only right away (`data class X(…) { … }`)
    const brace = m[5]
      ? (/^\s*(?::[^{\n]*)?\{/.exec(code.slice(after))?.[0].length ?? 0) - 1
      : code.slice(after).search(/[{;]/);
    if (brace >= 0 && code[after + brace] === "{") {
      const open = after + brace;
      const end = closing(code, open);
      members = [...members, ...bodyStatements(code, open + 1, end - 1, false)];
    }
    if (kotlin || kind === "record")
      add(name, at, members, kotlin ? kotlinMember : (s) => kotlinMember(s) ?? javaMember(s));
    else add(name, at, members, javaMember);
  }
  return out;
}

const WRAPPERS =
  /^(?:Optional|Mono|Flux|CompletableFuture|CompletionStage|Future|ResponseEntity|HttpEntity|Message|Promise|Observable|Nullable|NonNull|Readonly)$/;
const ARRAYS =
  /^(?:List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|TreeSet|SortedSet|Array|ReadonlyArray|MutableList|MutableSet|Sequence|Page|Slice)$/;
const STRINGS =
  /^(?:String|string|CharSequence|char|Character|UUID|Instant|LocalDate|LocalDateTime|LocalTime|OffsetDateTime|ZonedDateTime|Date|Duration|URI|URL|Char)$/;
const NUMBERS =
  /^(?:int|Integer|Int|long|Long|short|Short|byte|Byte|double|Double|float|Float|BigDecimal|BigInteger|Number|number|bigint|UInt|ULong)$/;
const BOOLEANS = /^(?:boolean|Boolean)$/;
const OBJECTS =
  /^(?:Map|HashMap|TreeMap|LinkedHashMap|MutableMap|Record|object|Object|Any|any|unknown|JsonNode|ObjectNode|JSONObject)$/;

/** A type's head and its generic arguments: `ResponseEntity<List<SlotDto>>` → ResponseEntity, [List<SlotDto>]. */
function generic(type: string): { head: string; args: string[] } {
  const t = type.replace(/^[\w.]+\./, (q) => (/^[a-z]/.test(q) ? "" : q)).trim();
  const lt = t.indexOf("<");
  if (lt < 0 || !t.endsWith(">")) return { head: t.replace(/^.*\./, ""), args: [] };
  return { head: t.slice(0, lt).replace(/^.*\./, ""), args: topLevel(t.slice(lt + 1, -1)) };
}

/**
 * A type as the wire sees it, the same in Java, Kotlin and TypeScript: `string`, `number`, `boolean`,
 * `object`, `array<…>`, or the DTO's name. `Long?`, `Optional<Long>` and `number | null` are `number`.
 */
export function wireType(type: string): string {
  let t = type.replace(/\s+/g, "").replace(/\?$/, "");
  const union = topLevel(t, "|").filter((p) => p !== "null" && p !== "undefined");
  if (union.length > 1) {
    const kinds = [...new Set(union.map(wireType))];
    // a union of string literals is a string on the wire
    return kinds.length === 1 ? (kinds[0] as string) : kinds.sort().join("|");
  }
  t = union[0] ?? t;
  if (/^["'].*["']$/.test(t)) return "string";
  if (/^-?\d/.test(t)) return "number";
  if (t === "true" || t === "false") return "boolean";
  if (t.endsWith("[]")) return `array<${wireType(t.slice(0, -2))}>`;
  const { head, args } = generic(t);
  if (WRAPPERS.test(head) && args.length > 0) return wireType(args[0] as string);
  if (ARRAYS.test(head)) return `array<${args[0] ? wireType(args[0]) : "object"}>`;
  if (STRINGS.test(head)) return "string";
  if (NUMBERS.test(head)) return "number";
  if (BOOLEANS.test(head)) return "boolean";
  if (OBJECTS.test(head) || head.startsWith("{")) return "object";
  return head;
}

/** A type whose fields can be compared: a DTO's name, not a string, a number, a map or `Object`. */
export function dtoNameOf(type: string | undefined): string | undefined {
  if (!type) return undefined;
  let w = wireType(type);
  while (w.startsWith("array<")) w = w.slice(6, -1);
  return /^[A-Z]\w*$/.test(w) ? w : undefined;
}

/** `KafkaTemplate<String, OrderCreatedEvent>` in a sender's file: the type it sends, if declared. */
export function sentTypeOf(content: string): string | undefined {
  const code = blankLiterals(content, true);
  const m = /\bKafkaTemplate\s*<([^;{}()]*)>/.exec(code);
  if (!m) return undefined;
  const args = topLevel(m[1] as string);
  return dtoNameOf(args[1]);
}

/** A method's parameters and return type, by its name: its declaration, not a call of it. */
function methodOf(code: string, method: string): { params: string[]; returns: string } | undefined {
  for (const m of code.matchAll(new RegExp(`\\b${method}\\s*\\(`, "g"))) {
    const at = m.index ?? 0;
    const before = code.slice(Math.max(0, at - 300), at).replace(ANNOTATION, " ");
    const prev = before.trimEnd();
    if (!prev || /[.=(,!&|?+\-*/:]$/.test(prev) || /\b(return|new|throw|else|case|await|yield)$/.test(prev))
      continue;
    const open = at + m[0].length - 1;
    const end = closing(code, open);
    const params = topLevel(code.slice(open + 1, end - 1));
    // a call's arguments are expressions; a declaration's parameters have a type and a name
    if (params.some((p) => !/\S\s+\w+$|^\w+\s*:/.test(p.replace(ANNOTATION, " ").trim()))) continue;
    const tail = code.slice(end, end + 200);
    if (!/^\s*(?:throws[\w.,\s]+)?[{;]|^\s*:\s*[\w<>[\],?\s.]+[{=]/.test(tail)) continue;
    const head = (before.split(/[;{}]/).at(-1) as string)
      .replace(
        /\b(public|protected|private|static|final|abstract|default|synchronized|suspend|fun|override|async)\b/g,
        " ",
      )
      .trim()
      .replace(/^<[^<>]*>\s*/, "");
    const returns = head.split(/\s+(?![^<]*>)/).at(-1) ?? "";
    const kotlinReturn = /^\s*:\s*([\w<>[\],?\s.]+?)\s*[{=]/.exec(tail)?.[1];
    return { params, returns: kotlinReturn ?? returns };
  }
  return undefined;
}

/** A parameter's type: `@RequestBody @Valid CreateOrder body` → CreateOrder; Kotlin `body: CreateOrder`. */
function paramType(param: string): string {
  const p = param
    .replace(ANNOTATION, " ")
    .replace(/\bfinal\b/g, " ")
    .trim();
  const kotlin = /^(?:val\s+|var\s+)?\w+\s*:\s*([\s\S]+)$/.exec(p);
  if (kotlin) return (kotlin[1] as string).trim();
  return p.replace(/\s+\w+$/, "").trim();
}

/** The type a listener method reads: its `@Payload` parameter, else the first one that is not a header. */
export function listenedTypeOf(content: string, method: string): string | undefined {
  const code = blankLiterals(content, true);
  const m = methodOf(code, method);
  if (!m) return undefined;
  const payload =
    m.params.find((p) => /@Payload\b/.test(p)) ??
    m.params.find(
      (p) =>
        !/@Header|@Headers/.test(p) &&
        !/^(Acknowledgment|Consumer|MessageHeaders|Channel)\b/.test(paramType(p)),
    );
  if (!payload) return undefined;
  const type = paramType(payload);
  const { head, args } = generic(type);
  // ConsumerRecord<String, OrderCreatedEvent> → the value
  if (/^(ConsumerRecord|ConsumerRecords)$/.test(head)) return dtoNameOf(args[1]);
  return dtoNameOf(type);
}

/** An endpoint method's body (`@RequestBody`) and response types, server or client alike. */
export function endpointTypesOf(
  content: string,
  method: string,
): { request?: string; response?: string } | undefined {
  const code = blankLiterals(content, true);
  const m = methodOf(code, method);
  if (!m) return undefined;
  const body = m.params.find((p) => /@RequestBody\b/.test(p));
  const request = body ? dtoNameOf(paramType(body)) : undefined;
  const response = dtoNameOf(m.returns);
  return { ...(request ? { request } : {}), ...(response ? { response } : {}) };
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
const show = (f: DtoField) => `${f.name}: ${f.type}`;

/**
 * The writer's fields against the reader's, by the name on the wire. A field only the writer has is
 * added (the reader ignores it); one only the reader has is removed (it reads what nobody writes); a
 * pair left on both sides with the same name in another case (`slot_id` / `slotId`), or the only pair
 * left with the same type, is renamed; the same name with another wire type is a changed type.
 */
export function compareFields(writer: DtoDecl, reader: DtoDecl): FieldRow[] {
  const rows: FieldRow[] = [];
  const w = new Map(writer.fields.map((f) => [f.name, f]));
  const r = new Map(reader.fields.map((f) => [f.name, f]));
  for (const [name, wf] of w) {
    const rf = r.get(name);
    if (!rf) continue;
    const same = wireType(wf.type) === wireType(rf.type);
    rows.push({
      field: name,
      change: same ? "same" : "type changed",
      status: same ? "ok" : "mismatch",
      writer: show(wf),
      reader: show(rf),
    });
  }
  let onlyW = writer.fields.filter((f) => !r.has(f.name));
  let onlyR = reader.fields.filter((f) => !w.has(f.name));
  const renamed = (a: DtoField, b: DtoField) => {
    rows.push({
      field: `${b.name} → ${a.name}`,
      change: "renamed",
      status: "mismatch",
      writer: show(a),
      reader: show(b),
    });
    onlyW = onlyW.filter((x) => x !== a);
    onlyR = onlyR.filter((x) => x !== b);
  };
  // the same field under another name on the wire: by its case, or by the name in the code
  // (`@JsonProperty("slot_id") Long deliverySlotId` against a plain `deliverySlotId`)
  const names = (f: DtoField) => [f.name, f.code].filter((n): n is string => n !== undefined).map(norm);
  for (const a of [...onlyW]) {
    const b = onlyR.find((x) => names(x).some((n) => names(a).includes(n)));
    if (b) renamed(a, b);
  }
  const [a] = onlyW;
  const [b] = onlyR;
  if (onlyW.length === 1 && onlyR.length === 1 && a && b && wireType(a.type) === wireType(b.type))
    renamed(a, b);
  for (const f of onlyW) rows.push({ field: f.name, change: "added", status: "ok", writer: show(f) });
  for (const f of onlyR) rows.push({ field: f.name, change: "removed", status: "mismatch", reader: show(f) });
  return rows.sort((x, y) => x.field.localeCompare(y.field));
}
