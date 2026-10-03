import { join } from "node:path";
import { BlobStore } from "../artifacts/blobs.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { BudgetManager } from "../budget/admission.ts";
import { SqliteUsageStore } from "../budget/usage.ts";
import type { LoadedConfig } from "../core/config/load.ts";
import { CompositeSecretResolver, EnvSecretResolver } from "../core/config/secrets.ts";
import { McpPool, ToolsCache } from "../mcp/client/pool.ts";
import { McpToolProvider } from "../mcp/provider.ts";
import { type CassetteMode, FileCassetteStore } from "../models/cassette.ts";
import { ModelGateway } from "../models/gateway.ts";
import { ProbeStore } from "../models/probe.ts";
import { FileCalibrationStore, TokenEstimator } from "../models/tokens.ts";
import { Keychain, KeychainSecretResolver } from "../security/credentials/keychain.ts";
import {
  compilePatterns,
  DEFAULT_DENIED_PATHS,
  PathPolicy,
  Redactor,
  secretLiteralsFromEnv,
} from "../security/redactor.ts";
import { CheckpointStore, StepHistoryStore } from "../storage/checkpoints.ts";
import { type OpenedDatabase, openDatabase } from "../storage/db.ts";
import { EffectJournal } from "../storage/effects.ts";
import { SqliteRunStore } from "../storage/runStore.ts";
import { SqliteEventStore } from "../telemetry/events.ts";
import { LocalToolProvider } from "../tools/local/provider.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolRouter } from "../tools/router.ts";

/** Everything that needs the database and the configuration, wired once per process. */
export interface Runtime {
  readonly loaded: LoadedConfig;
  readonly db: OpenedDatabase;
  readonly events: SqliteEventStore;
  readonly usage: SqliteUsageStore;
  readonly budget: BudgetManager;
  readonly gateway: ModelGateway;
  readonly probes: ProbeStore;
  readonly runs: SqliteRunStore;
  readonly blobs: BlobStore;
  readonly artifacts: ArtifactStore;
  readonly checkpoints: CheckpointStore;
  readonly history: StepHistoryStore;
  readonly effects: EffectJournal;
  readonly redactor: Redactor;
  readonly pathPolicy: PathPolicy;
  readonly registry: ToolRegistry;
  readonly tools: ToolRouter;
  readonly keychain: Keychain;
  readonly secrets: CompositeSecretResolver;
  readonly mcp: { readonly pool: McpPool; readonly provider: McpToolProvider };
  readonly env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/** Keychain namespace (ADR-0006 §4) without the async git lookup: env → config → "default". */
export function keychainActor(loaded: LoadedConfig, env: NodeJS.ProcessEnv): string {
  return env.JARVIS_ACTOR ?? loaded.config.actor.id ?? "default";
}

export function createKeychain(loaded: LoadedConfig, env: NodeJS.ProcessEnv): Keychain {
  return new Keychain({
    actorId: keychainActor(loaded, env),
    file: join(loaded.home.root, "credentials.json"),
    backend: env.JARVIS_KEYCHAIN_BACKEND,
  });
}

export interface RuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cassette?: { readonly mode: CassetteMode; readonly dir: string };
}

export function createRuntime(loaded: LoadedConfig, options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const db = openDatabase(loaded.home.dbFile);
  const events = new SqliteEventStore(db.db);
  const usage = new SqliteUsageStore(db.db);
  const budget = new BudgetManager(usage, loaded.config.quotaPools);
  const estimator = new TokenEstimator(new FileCalibrationStore(join(loaded.home.cacheDir, "models")));
  const security = loaded.config.security;
  const redactor = new Redactor({
    literals: secretLiteralsFromEnv(env, security.secretEnv),
    patterns: compilePatterns(security.secretPatterns),
  });
  const keychain = createKeychain(loaded, env);
  // Values pulled from the keychain join the Redactor's literal set the moment they are read (ADR-0010 §2).
  const secrets = new CompositeSecretResolver([
    new EnvSecretResolver(env),
    new KeychainSecretResolver(keychain, (value) => redactor.addLiterals([value])),
  ]);
  const gateway = new ModelGateway({
    config: loaded.config,
    secrets,
    usage,
    events,
    budget,
    estimator,
    ...(options.cassette
      ? { cassette: { mode: options.cassette.mode, store: new FileCassetteStore(options.cassette.dir) } }
      : {}),
  });
  const blobs = new BlobStore(db.db, join(loaded.home.artifactsDir, "blobs"));
  const pathPolicy = new PathPolicy([...DEFAULT_DENIED_PATHS, ...security.deniedPaths]);
  const registry = new ToolRegistry();
  registry.register(new LocalToolProvider(loaded.config));
  const pool = new McpPool({
    servers: loaded.config.mcp.servers,
    secrets,
    cache: new ToolsCache(join(loaded.home.cacheDir, "mcp")),
    env,
  });
  const mcpProvider = new McpToolProvider(loaded.config, pool);
  registry.register(mcpProvider);
  const partial = {
    loaded,
    db,
    events,
    usage,
    budget,
    gateway,
    probes: new ProbeStore(loaded.home.cacheDir),
    runs: new SqliteRunStore(db.db),
    blobs,
    artifacts: new ArtifactStore(db.db, blobs),
    checkpoints: new CheckpointStore(db.db),
    history: new StepHistoryStore(db.db),
    effects: new EffectJournal(db.db, blobs),
    redactor,
    pathPolicy,
    registry,
    keychain,
    secrets,
    mcp: { pool, provider: mcpProvider },
    env,
    close: async () => {
      await pool.close();
      db.close();
    },
  };
  const runtime: Runtime = { ...partial, tools: undefined as unknown as ToolRouter };
  const tools = new ToolRouter({ runtime, registry, redactor, pathPolicy });
  return { ...runtime, tools };
}
