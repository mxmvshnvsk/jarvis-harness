import { z } from "zod";
import { ModelError } from "./errors.ts";
import type { ModelCaller } from "./gateway.ts";
import type { StructuredMode } from "./router.ts";
import type { Message, ModelRequest, ModelResponse } from "./types.ts";

/**
 * Structured output with bounded repair (ADR-0007 §4).
 *
 * | mode   | request                                   | repairs |
 * | schema | response_format: json_schema (from Zod)   | ≤ 1     |
 * | json   | response_format: json_object + schema text | ≤ 2    |
 * | text   | schema text, fenced JSON extraction       | ≤ 2     |
 */
export const DEFAULT_REPAIRS: Record<StructuredMode, number> = { schema: 1, json: 2, text: 2 };

export interface StructuredOptions<T> {
  readonly modelId: string;
  readonly mode: StructuredMode;
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly messages: readonly Message[];
  readonly maxRepairs?: number;
  readonly request?: Omit<ModelRequest, "modelId" | "messages" | "responseFormat" | "tools">;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly response: ModelResponse;
  readonly repairs: number;
  readonly mode: StructuredMode;
  readonly totalUsage: { promptTokens: number; cachedTokens: number; outputTokens: number };
}

export class StructuredOutputError extends ModelError {
  readonly rawText: string;
  readonly issues: readonly string[];
  readonly repairs: number;

  constructor(modelId: string, rawText: string, issues: readonly string[], repairs: number) {
    super(
      "invalid",
      `model ${modelId}: structured output invalid after ${repairs} repair(s): ${issues.join("; ")}`,
      {
        modelId,
      },
    );
    this.name = "StructuredOutputError";
    this.rawText = rawText;
    this.issues = issues;
    this.repairs = repairs;
  }
}

/** Extracts the first JSON object/array from text, fenced or bare. */
export function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}

export type ParsedStructured<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: string[] };

/** Reads a structured document out of a model answer — fenced or bare JSON — and checks the schema. */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
  mode: StructuredMode = "text",
): ParsedStructured<T> {
  const raw = mode === "text" ? extractJson(text) : (extractJson(text) ?? text);
  if (raw === undefined) return { ok: false, issues: ["no JSON document found in the response"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, issues: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

function schemaInstruction(name: string, jsonSchema: Record<string, unknown>): string {
  return `Respond with a single JSON document named "${name}" that conforms to this JSON Schema and nothing else:\n${JSON.stringify(jsonSchema)}`;
}

function withSchemaHint(messages: readonly Message[], hint: string): Message[] {
  const out = [...messages];
  const systemIndex = out.findIndex((m) => m.role === "system");
  if (systemIndex >= 0) {
    const system = out[systemIndex] as Message;
    out[systemIndex] = { ...system, content: `${system.content}\n\n${hint}` };
  } else {
    out.unshift({ role: "system", content: hint });
  }
  return out;
}

export async function generateStructured<T>(
  gateway: ModelCaller,
  options: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const jsonSchema = z.toJSONSchema(options.schema, { target: "draft-7" }) as Record<string, unknown>;
  const maxRepairs = options.maxRepairs ?? DEFAULT_REPAIRS[options.mode];
  const base: Omit<ModelRequest, "messages"> = {
    ...options.request,
    modelId: options.modelId,
    ...(options.mode === "schema"
      ? { responseFormat: { kind: "schema", name: options.name, schema: jsonSchema } }
      : options.mode === "json"
        ? { responseFormat: { kind: "json" } }
        : { responseFormat: { kind: "text" } }),
  };
  const hint = schemaInstruction(options.name, jsonSchema);
  let messages: Message[] =
    options.mode === "schema" ? [...options.messages] : withSchemaHint(options.messages, hint);
  const totalUsage = { promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let repairs = 0;
  let lastText = "";
  let lastIssues: string[] = [];

  for (;;) {
    const response = await gateway.call({ ...base, messages });
    totalUsage.promptTokens += response.usage.promptTokens;
    totalUsage.cachedTokens += response.usage.cachedTokens;
    totalUsage.outputTokens += response.usage.outputTokens;
    lastText = response.text;
    const parsed = parseStructured(response.text, options.schema, options.mode);
    if (parsed.ok) {
      return { value: parsed.value, response, repairs, mode: options.mode, totalUsage };
    }
    const issues = parsed.issues;
    lastIssues = issues;
    if (repairs >= maxRepairs) break;
    repairs += 1;
    messages = [
      ...messages,
      { role: "assistant", content: response.text },
      {
        role: "user",
        content: `The previous output did not match the required schema:\n- ${issues.join("\n- ")}\nReturn only the corrected JSON document.`,
      },
    ];
  }
  throw new StructuredOutputError(options.modelId, lastText, lastIssues, repairs);
}
