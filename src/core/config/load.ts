import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import YAML from "yaml";
import type { z } from "zod";
import { discoverProject, type JarvisHome, jarvisHome, type ProjectPaths } from "../paths.ts";
import { envLayers, envOverrides } from "./env.ts";
import { ConfigError, type ConfigIssue, zodIssues } from "./errors.ts";
import { type ConfigLayer, isPlainObject, mergeLayers, type PlainObject } from "./merge.ts";
import { applyProfile } from "./profiles.ts";
import {
  CONFIG_VERSION,
  DATA_CLASS_ORDER,
  type DataClass,
  ProjectConfigSchema,
  type ResolvedConfig,
  ResolvedConfigSchema,
  UserConfigSchema,
} from "./schema.ts";
import { isSecretRef, looksLikeSecretKey } from "./secrets.ts";

export interface LoadOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Home directory used for `~/.jarvis`; defaults to the OS home directory. */
  readonly homeDir?: string;
  /** Structured overrides from CLI flags, highest precedence. */
  readonly cliOverrides?: PlainObject;
  /** Profile to apply; defaults to `JARVIS_PROFILE`. */
  readonly profile?: string;
}

export interface ConfigFileInfo {
  readonly path: string;
  readonly exists: boolean;
}

export interface LoadedConfig {
  readonly config: ResolvedConfig;
  /** Leaf path → origin (`user:…`, `project:…`, `env:JARVIS_…`, `cli`, `profile:<name>`). */
  readonly sources: Record<string, string>;
  readonly files: { readonly user: ConfigFileInfo; readonly project?: ConfigFileInfo };
  readonly home: JarvisHome;
  readonly project?: ProjectPaths;
  readonly warnings: readonly string[];
}

export const SOURCE_DEFAULT = "default";

async function readYamlFile(path: string): Promise<{ exists: boolean; value: unknown }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, value: undefined };
    throw error;
  }
  const value: unknown = stripNulls(YAML.parse(text) ?? {});
  if (!isPlainObject(value)) {
    throw new ConfigError(`configuration file is not a mapping: ${path}`, []);
  }
  return { exists: true, value };
}

function validateFile(schema: z.ZodType, value: unknown, source: string): ConfigIssue[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return zodIssues(result.error).map((issue) => ({ ...issue, source }));
}

function checkVersion(value: unknown, source: string): ConfigIssue[] {
  if (!isPlainObject(value) || value.version === undefined) {
    return [{ path: "version", message: `missing "version: ${CONFIG_VERSION}"`, source }];
  }
  if (typeof value.version === "number" && value.version > CONFIG_VERSION) {
    return [
      {
        path: "version",
        message: `configuration version ${value.version} is newer than this jarvis supports (${CONFIG_VERSION}); upgrade jarvis`,
        source,
      },
    ];
  }
  return [];
}

function crossChecks(config: ResolvedConfig, sources: Record<string, string>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const withSource = (path: string, message: string): ConfigIssue => {
    const source = sourceFor(path, sources);
    return source ? { path, message, source } : { path, message };
  };

  for (const [role, def] of Object.entries(config.roles)) {
    def.models.forEach((id, i) => {
      if (!config.models[id]) {
        issues.push(withSource(`roles.${role}.models[${i}]`, `unknown model "${id}"`));
      }
    });
  }
  for (const [id, model] of Object.entries(config.models)) {
    if (model.quotaPool !== undefined && !config.quotaPools[model.quotaPool]) {
      issues.push(withSource(`models.${id}.quotaPool`, `unknown quota pool "${model.quotaPool}"`));
    }
    for (const [header, value] of Object.entries(model.headers)) {
      if (looksLikeSecretKey(header) && !isSecretRef(value)) {
        issues.push(
          withSource(
            `models.${id}.headers.${header}`,
            "header looks like a secret; use env:VAR or keychain:ID",
          ),
        );
      }
    }
    if (
      model.provider !== "ollama" &&
      model.baseUrl === undefined &&
      model.provider === "openai-compatible"
    ) {
      issues.push(withSource(`models.${id}.baseUrl`, "openai-compatible provider requires baseUrl"));
    }
  }
  return issues;
}

export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = jarvisHome(env, options.homeDir ?? homedir());
  const project = discoverProject(cwd);
  const warnings: string[] = [];
  const issues: ConfigIssue[] = [];

  const userSource = `user:${home.configFile}`;
  const user = await readYamlFile(home.configFile);
  if (user.exists) {
    issues.push(...checkVersion(user.value, userSource));
    if (issues.length === 0) issues.push(...validateFile(UserConfigSchema, user.value, userSource));
  }

  let projectFile: ConfigFileInfo | undefined;
  let projectValue: unknown;
  let projectSource: string | undefined;
  if (project) {
    projectSource = `project:${project.configFile}`;
    const read = await readYamlFile(project.configFile);
    projectFile = { path: project.configFile, exists: read.exists };
    projectValue = read.value;
    if (read.exists) {
      const versionIssues = checkVersion(read.value, projectSource);
      issues.push(...versionIssues);
      if (versionIssues.length === 0)
        issues.push(...validateFile(ProjectConfigSchema, read.value, projectSource));
    }
  }
  if (issues.length > 0) throw new ConfigError("invalid configuration", issues);

  const layers: ConfigLayer[] = [
    { name: SOURCE_DEFAULT, value: { version: CONFIG_VERSION } },
    { name: userSource, value: stripVersion(user.value) },
  ];
  if (projectSource) layers.push({ name: projectSource, value: stripVersion(projectValue) });

  const fileMerge = mergeLayers(layers);
  layers.push(...envLayers(envOverrides(env, fileMerge.value)));
  if (options.cliOverrides) layers.push({ name: "cli", value: options.cliOverrides });

  const merged = mergeLayers(layers);
  const parsed = ResolvedConfigSchema.safeParse(merged.value);
  if (!parsed.success) {
    throw new ConfigError("invalid configuration", zodIssues(parsed.error, merged.sources));
  }

  let config = parsed.data;
  const sources = { ...merged.sources };

  // ADR-0016 §2: env and CLI may raise the data class, never lower it.
  const fileDataClass = isPlainObject(fileMerge.value) ? fileMerge.value.dataClass : undefined;
  if (typeof fileDataClass === "string" && fileDataClass in DATA_CLASS_ORDER) {
    const fileOrder = DATA_CLASS_ORDER[fileDataClass as DataClass];
    if (DATA_CLASS_ORDER[config.dataClass] < fileOrder) {
      throw new ConfigError("invalid configuration", [
        {
          path: "dataClass",
          message: `dataClass may not be lowered from "${fileDataClass}" to "${config.dataClass}" by ${sources.dataClass ?? "an override"}`,
          source: sources.dataClass ?? "cli",
        },
      ]);
    }
  }

  const profileName = options.profile ?? env.JARVIS_PROFILE;
  if (profileName) {
    const overlay = config.profiles[profileName];
    if (!overlay) {
      throw new ConfigError("invalid configuration", [
        { path: `profiles.${profileName}`, message: `profile "${profileName}" is not defined` },
      ]);
    }
    const applied = applyProfile(config, profileName, overlay);
    if (applied.issues.length > 0) throw new ConfigError("invalid profile", applied.issues);
    config = applied.config;
    for (const path of applied.changed) sources[path] = `profile:${profileName}`;
  }

  const cross = crossChecks(config, sources);
  if (cross.length > 0) throw new ConfigError("invalid configuration", cross);

  if (!project)
    warnings.push(
      "no project found (no .jarvis/project.yaml or .git upwards); project settings are defaults",
    );
  else if (!projectFile?.exists) warnings.push(`project has no ${project.configFile}; run "jarvis init"`);
  if (!user.exists) warnings.push(`no user configuration at ${home.configFile}; run "jarvis init"`);

  const files = projectFile
    ? { user: { path: home.configFile, exists: user.exists }, project: projectFile }
    : { user: { path: home.configFile, exists: user.exists } };

  return project
    ? { config, sources, files, home, project, warnings }
    : { config, sources, files, home, warnings };
}

/** Finds the source of a path or of its nearest recorded ancestor (arrays are recorded as leaves). */
export function sourceFor(path: string, sources: Record<string, string>): string | undefined {
  let current = path;
  for (;;) {
    const found = sources[current];
    if (found) return found;
    const trimmed = current.replace(/(\[[^\]]*\]|\.[^.[\]]+)$/, "");
    if (trimmed === current || trimmed === "") return undefined;
    current = trimmed;
  }
}

/** A key with nothing under it (`models:` followed only by comments) means "not set". */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isPlainObject(value)) return value;
  const out: PlainObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null) continue;
    out[key] = stripNulls(child);
  }
  return out;
}

function stripVersion(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const { version: _version, ...rest } = value;
  return rest;
}
