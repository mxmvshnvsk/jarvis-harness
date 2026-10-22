import { existsSync } from "node:fs";
import { applyRun } from "../../app/applyRun.ts";
import { isAutonomous, noteAutonomy } from "../../app/autonomy.ts";
import {
  CONTRACT_CHANGED,
  contractChangeAsked,
  contractDecisionOf,
  libraryAwaited,
  recordContractRequest,
} from "../../app/contractChange.ts";
import {
  checkoutOf,
  type DtoCheck,
  dtoChecksOf,
  fieldsMismatch,
  type SideFacts,
} from "../../app/contractFields.ts";
import { crossCatalogText } from "../../app/crossCatalog.ts";
import { SCOPE_TYPE, scopeDecision, scopeOf } from "../../app/crossScope.ts";
import { readStoryTasks, STORY_TASKS, storyTasksText } from "../../app/storyTasks.ts";
import {
  type ContractItem,
  deliveryOrder,
  isDone,
  scheduleSubtasks,
  splitOf,
  subtasksOf,
} from "../../app/subtasks.ts";
import type { Run } from "../../core/domain/run.ts";
import { codeContractsOf } from "../../design/codeContracts.ts";
import {
  parseEndpoint,
  type ServiceContracts,
  sameEndpoint,
  serviceContractsOf,
  springConfigOf,
} from "../../knowledge/catalog.ts";
import { repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { trackedFiles } from "../../onboarding/scan.ts";
import type { DeterministicTool } from "../executors.ts";
import type { StepContext, StepOutcome } from "../types.ts";
import { SuspendRun } from "../types.ts";

/**
 * The deterministic steps of a task across services (ADR-0025 §6): the catalog for the split, the
 * subtasks started, the wait for them, the contract checked in their checkouts, the delivery in order.
 */

const meta = (ctx: StepContext) => ctx.runtime.loaded.meta;

const put = (ctx: StepContext, type: string, name: string, content: string, mediaType?: string) => {
  const a = ctx.runtime.artifacts.put({
    runId: ctx.run.id,
    type,
    name,
    content,
    ...(mediaType ? { mediaType } : {}),
    provenance: { kind: "tool", capability: `cross.${type}` },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  return `${a.artifactId}@${a.version}`;
};

/** `cross.catalog`: the services, their links, the libraries and what the task names — for the research and the split. */
const catalogStep: DeterministicTool = async (ctx) => {
  const text = crossCatalogText(ctx.runtime, ctx.run);
  if (text === undefined)
    return { status: "failure", reason: "a task across services runs in a knowledge repository (ADR-0025)" };
  // a task that is a Story (or in one): its Jira tasks per side, for the split to tie each subtask to one
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const story = available.has("jira.get")
    ? await readStoryTasks(ctx.runtime, ctx.run.task, async (name, args) => {
        const r = await ctx.tools.invoke(name, args);
        return { ok: r.ok, text: r.truncated && r.fullRef ? ctx.runtime.blobs.getText(r.fullRef) : r.text };
      }).catch(() => undefined)
    : undefined;
  const outputs = [put(ctx, "catalog", "catalog.md", story ? `${text}\n\n${storyTasksText(story)}` : text)];
  if (story) outputs.push(put(ctx, STORY_TASKS, "story-tasks.json", JSON.stringify(story, null, 2)));
  return { status: "success", outputs };
};

/** `cross.spawn`: the approved split's subtasks, the first ones started. */
const spawnStep: DeterministicTool = async (ctx) => {
  const m = meta(ctx);
  if (!m)
    return { status: "failure", reason: "a task across services runs in a knowledge repository (ADR-0025)" };
  const split = splitOf(ctx.runtime, ctx.run);
  if (!split || split.subtasks.length === 0)
    return { status: "failure", reason: "no approved split with subtasks" };
  const unknown = split.subtasks.filter((s) => !m.repos[s.service]).map((s) => s.service);
  if (unknown.length > 0)
    return {
      status: "failure",
      reason: `not services of the map: ${[...new Set(unknown)].join(", ")} — fix the split, or add them to services in ${m.configFile}`,
    };
  const missing = split.subtasks
    .filter((s) => !existsSync(m.repos[s.service] as string))
    .map((s) => s.service);
  if (missing.length > 0)
    return {
      status: "failure",
      reason: `no repository on this machine for ${missing.join(", ")} — repos.<service> in the personal config`,
    };
  const started = scheduleSubtasks(ctx.runtime, ctx.run);
  ctx.runtime.events.emit({
    kind: "subtasks.spawned",
    runId: ctx.run.id,
    stepId: ctx.step.id,
    // a subtask's share of the master's budget until its own process records its service's
    payload: { subtasks: split.subtasks.length, started, budget: ctx.runtime.loaded.config.budget.perRun },
  });
  return { status: "success" };
};

/** `cross.wait`: parks the master until every subtask is completed (or dropped by a person). */
const waitStep: DeterministicTool = async (ctx) => {
  scheduleSubtasks(ctx.runtime, ctx.run);
  const views = subtasksOf(ctx.runtime, ctx.run);
  if (views.length > 0 && views.every(isDone)) return { status: "success" };
  const done = views.filter(isDone).length;
  const detail = views.map((v) => `${v.subtask.key} ${v.subtask.service}: ${v.state}`).join("; ");
  throw new SuspendRun("SUSPENDED", `waits for its subtasks: ${done} of ${views.length} done`, {
    waitingFor: { kind: "children", detail },
  });
};

export interface ContractSide {
  readonly service: string;
  /** `mismatch`: the method, path or topic holds, a field of its DTO does not. */
  readonly status: "ok" | "missing" | "mismatch" | "not checked" | "no checkout";
  readonly at?: string;
  readonly note?: string;
  /** A consumer's side: its DTOs against the producer's, field by field. */
  readonly fields?: readonly DtoCheck[];
}

export interface ContractCheckItem extends ContractItem {
  readonly producerSide: ContractSide;
  readonly consumerSides: readonly ContractSide[];
}

/** A subtask's contracts as its checkout has them now. */
async function factsAt(ctx: StepContext, run: Run, service: string): Promise<ServiceContracts | undefined> {
  const path = run.workspace.path;
  if (!existsSync(path)) return undefined;
  const extractors = (ctx.runtime.capabilities?.list() ?? [])
    .map((a) => a.graphExtractor?.())
    .filter((e) => e !== undefined);
  const result = await updateGraph({
    workspace: path,
    repoId: repoIdOf(path),
    cacheRoot: ctx.runtime.loaded.home.cacheDir,
    extractors,
    store: ctx.runtime.graph,
  });
  const code = codeContractsOf([...result.snapshot.nodes]);
  return serviceContractsOf(service, code, springConfigOf(path, await trackedFiles(path)));
}

const where = (e: { file: string; line?: number }) => (e.line ? `${e.file}:${e.line}` : e.file);

/** A DTO the contract names, on its producer's side: declared in its checkout, or not seen there. */
function dtoProducerSide(item: ContractItem, side: SideFacts): ContractSide {
  const service = side.service;
  if (!side.checkout) return { service, status: "no checkout" };
  const decl = side.checkout.findDto(item.id.replace(/^.*\./, ""));
  return decl
    ? { service, status: "ok", at: `${decl.file}:${decl.line}` }
    : {
        service,
        status: "not checked",
        note: `${item.id} is not declared in its checkout (a library's type?): fields not checked`,
      };
}

/** A consumer's side with its DTOs compared to the producer's: a field that does not hold is a mismatch. */
function withFields(side: ContractSide, checks: readonly DtoCheck[]): ContractSide {
  if (checks.length === 0) return side;
  if (fieldsMismatch(checks) && (side.status === "ok" || side.status === "not checked"))
    return { service: side.service, status: "mismatch", ...(side.at ? { at: side.at } : {}), fields: checks };
  // a DTO's consumer: compared field by field, it holds
  if (side.status === "not checked" && checks.every((c) => c.fields))
    return { service: side.service, status: "ok", at: checks[0]?.readerAt ?? "", fields: checks };
  return { ...side, fields: checks };
}

/** One side of a contract item in its service's facts. */
function sideOf(
  item: ContractItem,
  facts: ServiceContracts | undefined,
  service: string,
  producer: boolean,
): ContractSide {
  if (item.kind === "dto")
    return {
      service,
      status: "not checked",
      note: "fields are checked only where the type is declared (ADR-0025 §6)",
    };
  if (!facts) return { service, status: "no checkout" };
  if (item.kind === "topic") {
    const hit = producer
      ? facts.produces.find((t) => t.topic === item.id)
      : facts.consumes.find((t) => t.topic === item.id);
    return hit ? { service, status: "ok", at: where(hit) } : { service, status: "missing" };
  }
  const wanted = parseEndpoint(item.id);
  const segment = producer ? undefined : item.producer;
  const hit = producer
    ? facts.serves.find((e) => sameEndpoint(e, wanted))
    : facts.calls.find((e) => sameEndpoint(e, wanted, segment));
  return hit ? { service, status: "ok", at: where(hit) } : { service, status: "missing" };
}

/** `cross.check`: each side of the contract in its subtask's checkout, without a model. */
const checkStep: DeterministicTool = async (ctx) => {
  const split = splitOf(ctx.runtime, ctx.run);
  if (!split) return { status: "failure", reason: "no approved split" };
  const views = subtasksOf(ctx.runtime, ctx.run);
  const sides = new Map<string, SideFacts>();
  for (const v of views)
    if (v.run && v.state !== "dropped") {
      const service = v.subtask.service;
      const facts = await factsAt(ctx, v.run, service);
      const checkout = await checkoutOf(v.run);
      sides.set(service, { service, ...(facts ? { facts } : {}), ...(checkout ? { checkout } : {}) });
    }
  const inTask = new Set(views.filter((v) => v.state !== "dropped").map((v) => v.subtask.service));
  const side = (item: ContractItem, service: string, producer: boolean): ContractSide => {
    if (!inTask.has(service))
      return { service, status: "not checked", note: "not a subtask of this task: it does not change" };
    const facts = sides.get(service) ?? { service };
    if (item.kind === "dto" && producer) return dtoProducerSide(item, facts);
    const plain = sideOf(item, facts.facts, service, producer);
    if (producer || !inTask.has(item.producer)) return plain;
    // the method, path or topic is the same: then the fields of what goes between them
    return withFields(
      plain,
      dtoChecksOf(item, sides.get(item.producer) ?? { service: item.producer }, facts),
    );
  };
  const items: ContractCheckItem[] = split.contract.map((item) => ({
    ...item,
    producerSide: side(item, item.producer, true),
    consumerSides: item.consumers.map((c) => side(item, c, false)),
  }));
  const broken = items
    .flatMap((i) => [i.producerSide, ...i.consumerSides])
    .filter((s) => s.status === "missing" || s.status === "mismatch");
  const doc = { ok: broken.length === 0, items };
  const ref = put(
    ctx,
    "contract-check",
    "contract-check.json",
    JSON.stringify(doc, null, 2),
    "application/json",
  );
  return { status: "success", outputs: [ref] };
};

/** `cross.deliver`: each subtask's changes applied in its repository, in delivery order. */
const deliverStep: DeterministicTool = async (ctx) => {
  const split = splitOf(ctx.runtime, ctx.run);
  if (!split) return { status: "failure", reason: "no approved split" };
  const views = new Map(subtasksOf(ctx.runtime, ctx.run).map((v) => [v.subtask.key, v]));
  const applied: string[] = [];
  for (const s of deliveryOrder(split.subtasks)) {
    const v = views.get(s.key);
    if (!v || v.state === "dropped") continue;
    if (v.run?.state !== "COMPLETED")
      return { status: "failure", reason: `subtask ${s.key} (${s.service}) is not completed: ${v.state}` };
    if (ctx.runtime.events.list({ runId: v.run.id, kind: "run.applied", limit: 1 }).length > 0) continue;
    try {
      await applyRun(ctx.runtime, v.run, ctx.run.owner, process.env);
      applied.push(`${s.key} ${s.service}`);
    } catch (error) {
      return {
        status: "failure",
        reason: `${s.key} ${s.service} not applied${applied.length > 0 ? ` (applied: ${applied.join(", ")})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  ctx.runtime.events.emit({
    kind: "subtasks.delivered",
    runId: ctx.run.id,
    stepId: ctx.step.id,
    payload: { applied },
  });
  return { status: "success" };
};

/**
 * `scope.check` of a subtask (ADR-0025 §6): its impact asks to change the contract — it parks until a
 * person decides on the master. Accepted: back to the impact with the new contract (where the
 * workflow has that edge); rejected: on with the contract as agreed. Nothing asked: on at once.
 */
async function contractStep(ctx: StepContext): Promise<StepOutcome> {
  const asked = contractChangeAsked(ctx.runtime, ctx.run);
  const masterId = ctx.run.options?.parent?.runId;
  const master = masterId ? ctx.runtime.runs.get(masterId) : undefined;
  if (!asked || !master) return { status: "success" };
  const decided = contractDecisionOf(ctx.runtime, master.id, asked.id);
  if (!decided && isAutonomous(ctx.run)) {
    // nobody to decide on the master: on with the contract as agreed, the ask said in the journal
    noteAutonomy(ctx.runtime, ctx.run, "contract", { kept: "agreed", item: asked.ask.item }, ctx.step.id);
    return { status: "success" };
  }
  if (!decided) {
    recordContractRequest(ctx.runtime, master, ctx.run, asked);
    throw new SuspendRun("WAITING_HUMAN", `asks the master to change the contract: ${asked.ask.item}`, {
      waitingFor: { kind: "contract", detail: asked.ask.item },
    });
  }
  // accepted as a library's change: the library changes first, this run builds against its new version
  const library = decided.choice === "accept" ? libraryAwaited(ctx.runtime, master, ctx.run) : undefined;
  if (library)
    throw new SuspendRun(
      "WAITING_HUMAN",
      `waits for the library ${library.service} (subtask ${library.key}): its change accepted and published`,
      { waitingFor: { kind: "contract", detail: `library ${library.service}` } },
    );
  return decided.choice === "accept" && ctx.step.transitions.onOutcome[CONTRACT_CHANGED]
    ? { status: "success", outcome: CONTRACT_CHANGED }
    : { status: "success" };
}

/**
 * `scope.check` (an sdd in a service, after impact; ADR-0025 §7): a requirement the analysis ties to
 * another service that the catalog links to this one stops the run at the scope gate; anything else
 * passes on — with the report kept when it says something.
 */
const scopeStep: DeterministicTool = async (ctx) => {
  if (ctx.run.options?.parent) return contractStep(ctx);
  const report = scopeOf(ctx.runtime, ctx.run);
  if (!report) return { status: "success" };
  const said = report.spans.length + report.unconfirmed.length + report.consumers.length > 0;
  if (!said) return { status: "success" };
  const text = JSON.stringify(report, null, 2);
  const latest = ctx.runtime.artifacts.listLatest(ctx.run.id, SCOPE_TYPE)[0];
  const ref =
    latest && ctx.runtime.artifacts.text(latest) === text
      ? `${latest.artifactId}@${latest.version}`
      : put(ctx, SCOPE_TYPE, "scope.json", text, "application/json");
  if (report.spans.length === 0 || scopeDecision(ctx.runtime, ctx.run.id) === "single")
    return { status: "success", outputs: [ref] };
  const others = [...new Set(report.spans.map((r) => r.service))];
  if (isAutonomous(ctx.run)) {
    // nobody to choose: the task stays in this service, the others named in the report
    noteAutonomy(ctx.runtime, ctx.run, "scope", { kept: "single", others }, ctx.step.id);
    return { status: "success", outputs: [ref] };
  }
  throw new SuspendRun(
    "WAITING_HUMAN",
    `the task reaches ${others.length === 1 ? "another service" : `${others.length} more services`}: ${others.join(", ")}`,
    { waitingFor: { kind: "scope", detail: others.join(", ") } },
  );
};

export const CROSS_TOOLS: Record<string, DeterministicTool> = {
  "scope.check": scopeStep,
  "cross.catalog": catalogStep,
  "cross.spawn": spawnStep,
  "cross.wait": waitStep,
  "cross.check": checkStep,
  "cross.deliver": deliverStep,
};
