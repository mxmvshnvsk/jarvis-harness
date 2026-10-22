import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";

/**
 * A library among the services of a knowledge repository (ADR-0025): a repository the others depend on
 * by a published name, which in a task across services changes first. Read from the build files, no
 * model: Gradle with `maven-publish` and no application plugin, a Maven project without the Spring Boot
 * plugin and not a war, an npm package that is not private and has an entry point. Which services use
 * it — the build files that name its coordinates or its package.
 */
export interface LibraryFacts {
  /** The names services depend on it by: `group:artifact` for Maven, the package name for npm. */
  readonly publishes: readonly string[];
  /** The command that publishes it where the services' builds find it on this machine. */
  readonly publishLocal: string;
}

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const first = (text: string | undefined, re: RegExp): string | undefined =>
  text ? (re.exec(text)?.[1] ?? undefined) : undefined;

/**
 * A Gradle build of an application: the Spring Boot plugin applied (its bootJar not turned off) or the
 * application plugin. A Spring Boot starter names org.springframework.boot in its dependencies and is a
 * library all the same (pilot: a common starter of the services was not found as one).
 */
function isApplication(build: string): boolean {
  const boot =
    /id\s*\(?\s*["']org\.springframework\.boot["']|apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']|alias\s*\(\s*libs\.plugins\.spring\.?boot\s*\)/.test(
      build,
    );
  const bootJarOff =
    /bootJar\s*\{[^}]*enabled\s*=\s*false|bootJar\.enabled\s*=\s*false|named<BootJar>\("bootJar"\)\s*\{[^}]*enabled\s*=\s*false/.test(
      build,
    );
  const application =
    /^\s*application\s*\{|id\s*\(?\s*["']application["']|apply\s*\(?\s*plugin\s*[:=]\s*["']application["']/m.test(
      build,
    );
  return (boot && !bootJarOff) || application;
}

function gradleLibrary(root: string): LibraryFacts | undefined {
  const build = read(join(root, "build.gradle.kts")) ?? read(join(root, "build.gradle"));
  if (!build || !/maven-publish/.test(build)) return undefined;
  if (isApplication(build)) return undefined;
  const props = read(join(root, "gradle.properties"));
  const group =
    first(build, /^\s*group\s*=\s*["']([^"']+)["']/m) ?? first(props, /^\s*group\s*=\s*(\S+)\s*$/m);
  const settings = read(join(root, "settings.gradle.kts")) ?? read(join(root, "settings.gradle"));
  const artifact =
    first(build, /artifactId\s*=\s*["']([^"']+)["']/) ??
    first(settings, /rootProject\.name\s*=\s*["']([^"']+)["']/) ??
    basename(root);
  const wrapper = existsSync(join(root, "gradlew")) ? "./gradlew" : "gradle";
  return {
    publishes: [group ? `${group}:${artifact}` : artifact],
    publishLocal: `${wrapper} publishToMavenLocal`,
  };
}

function mavenLibrary(root: string): LibraryFacts | undefined {
  const pom = read(join(root, "pom.xml"));
  if (!pom) return undefined;
  if (/spring-boot-maven-plugin/.test(pom) || /<packaging>\s*war\s*<\/packaging>/.test(pom)) return undefined;
  // the project's own coordinates, not its parent's
  const own = pom
    .replace(/<parent>[\s\S]*?<\/parent>/, "")
    .replace(/<dependencies>[\s\S]*<\/dependencies>/, "");
  const artifact = first(own, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
  const group =
    first(own, /<groupId>\s*([^<\s]+)\s*<\/groupId>/) ?? first(pom, /<parent>[\s\S]*?<groupId>\s*([^<\s]+)/);
  if (!artifact) return undefined;
  const wrapper = existsSync(join(root, "mvnw")) ? "./mvnw" : "mvn";
  return {
    publishes: [group ? `${group}:${artifact}` : artifact],
    publishLocal: `${wrapper} -q install -DskipTests`,
  };
}

function npmLibrary(root: string): LibraryFacts | undefined {
  const text = read(join(root, "package.json"));
  if (!text) return undefined;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (pkg.private === true || typeof pkg.name !== "string") return undefined;
  if (!["main", "module", "exports", "types"].some((k) => pkg[k] !== undefined)) return undefined;
  return { publishes: [pkg.name], publishLocal: "npm pack" };
}

/** The repository's library facts, when its build says it is one. */
export function libraryOf(root: string): LibraryFacts | undefined {
  return gradleLibrary(root) ?? mavenLibrary(root) ?? npmLibrary(root);
}

const BUILD_FILES = new Set(["pom.xml", "package.json", "libs.versions.toml"]);
/**
 * A build file: those above and every Gradle script — dependencies are often kept in one the build
 * applies (`apply from: 'libraries.gradle'`; pilot: a service's use of a common starter not seen).
 */
const isBuildFile = (name: string): boolean =>
  BUILD_FILES.has(name) || name.endsWith(".gradle") || name.endsWith(".gradle.kts");
const SKIP = new Set(["node_modules", ".git", "build", "target", "dist", ".gradle", "src"]);

/** The build files of a repository: at its root and in its modules, three levels down at most. */
function buildFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (isBuildFile(name)) out.push(join(dir, name));
      else if (depth < 3 && !SKIP.has(name) && !name.startsWith(".")) {
        const sub = join(dir, name);
        try {
          if (statSync(sub).isDirectory()) walk(sub, depth + 1);
        } catch {
          // gone while reading
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Whether a build file depends on the name: `group:artifact` in Gradle and TOML, both tags in a pom, a package key. */
function dependsOn(file: string, text: string, name: string): boolean {
  if (file.endsWith("package.json")) {
    try {
      const pkg = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
      return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
        (k) => pkg[k]?.[name] !== undefined,
      );
    } catch {
      return false;
    }
  }
  const [group, artifact] = name.includes(":") ? (name.split(":") as [string, string]) : [undefined, name];
  if (file.endsWith("pom.xml"))
    return (
      new RegExp(`<artifactId>\\s*${escapeRe(artifact)}\\s*</artifactId>`).test(text) &&
      (!group || text.includes(group))
    );
  if (group)
    return text.includes(`${group}:${artifact}`) || (text.includes(group) && text.includes(`"${artifact}"`));
  return text.includes(artifact);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The libraries of the map a repository depends on, by their published names. */
export function usesOf(root: string, libraries: ReadonlyMap<string, readonly string[]>): string[] {
  const files = buildFiles(root).map((f) => ({ f, text: read(f) ?? "" }));
  const out: string[] = [];
  for (const [service, names] of libraries)
    if (names.some((n) => files.some(({ f, text }) => dependsOn(f, text, n)))) out.push(service);
  return out.sort();
}

/** The libraries among the repositories of a map: service → published names. */
export function librariesOf(
  repos: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, readonly string[]>> = {},
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [service, root] of Object.entries(repos)) {
    const names = declared[service] ?? (existsSync(root) ? libraryOf(root)?.publishes : undefined);
    if (names && names.length > 0) out.set(service, names);
  }
  return out;
}

/** `services.<name>.publishes` as the map's text has them: what a person declared wins over the scan. */
export function declaredPublishes(mapText: string): Record<string, readonly string[]> {
  let doc: unknown;
  try {
    doc = YAML.parse(mapText);
  } catch {
    return {};
  }
  const services = (doc as { services?: Record<string, { publishes?: unknown } | null> } | null)?.services;
  const out: Record<string, readonly string[]> = {};
  for (const [name, entry] of Object.entries(services ?? {})) {
    const p = entry?.publishes;
    if (Array.isArray(p)) out[name] = p.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** The version a library's checkout builds now: Gradle's `version`, its pom's own, package.json's. */
export function libraryVersionOf(root: string): string | undefined {
  const gradle =
    first(read(join(root, "gradle.properties")), /^\s*version\s*=\s*(\S+)\s*$/m) ??
    first(
      read(join(root, "build.gradle.kts")) ?? read(join(root, "build.gradle")),
      /^\s*version\s*=\s*["']([^"']+)["']/m,
    );
  if (gradle) return gradle;
  const pom = read(join(root, "pom.xml"));
  const own = pom
    ?.replace(/<parent>[\s\S]*?<\/parent>/, "")
    .replace(/<dependencies>[\s\S]*<\/dependencies>/, "");
  const maven = first(own, /<version>\s*([^<\s]+)\s*<\/version>/);
  if (maven) return maven;
  try {
    const pkg = JSON.parse(read(join(root, "package.json")) ?? "") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
