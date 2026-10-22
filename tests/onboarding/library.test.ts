import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { declaredPublishes, librariesOf, libraryOf, usesOf } from "../../src/onboarding/library.ts";
import { fillServiceEntry } from "../../src/onboarding/serviceEntry.ts";

/** A library among the services: from the build files, and who depends on it. */
let dir: string;
const write = (rel: string, text: string) => {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lib-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a library, by its build", () => {
  it("Gradle with maven-publish and no application: group and name, publishToMavenLocal", () => {
    write(
      "common-lib/build.gradle",
      "plugins {\n  id 'java-library'\n  id 'maven-publish'\n}\ngroup = 'com.example'\n",
    );
    write("common-lib/settings.gradle", "rootProject.name = 'common-lib'\n");
    write("common-lib/gradlew", "");
    expect(libraryOf(join(dir, "common-lib"))).toEqual({
      publishes: ["com.example:common-lib"],
      publishLocal: "./gradlew publishToMavenLocal",
    });
  });

  it("a Spring Boot application that publishes is not a library", () => {
    write("orders-api/build.gradle", "plugins {\n  id 'org.springframework.boot'\n  id 'maven-publish'\n}\n");
    expect(libraryOf(join(dir, "orders-api"))).toBeUndefined();
  });

  it("a Spring Boot starter is a library: Boot in its dependencies, not its plugin (pilot)", () => {
    write(
      "common-starter/build.gradle",
      [
        "plugins {",
        "  id 'java-library'",
        "  id 'maven-publish'",
        "  id 'io.spring.dependency-management' version '1.1.7'",
        "}",
        "group = 'com.example.common'",
        'version = "local"',
        "dependencies {",
        "  api 'org.springframework.boot:spring-boot-starter-web'",
        "  annotationProcessor 'org.springframework.boot:spring-boot-autoconfigure-processor'",
        "}",
      ].join("\n"),
    );
    write("common-starter/settings.gradle", "rootProject.name = 'common-starter'\n");
    expect(libraryOf(join(dir, "common-starter"))?.publishes).toEqual(["com.example.common:common-starter"]);
    // the plugin applied with its boot jar turned off: a library too; applied as is: an application
    write(
      "kit/build.gradle.kts",
      'plugins {\n  id("org.springframework.boot")\n  `maven-publish`\n}\ntasks.bootJar { enabled = false }\n',
    );
    expect(libraryOf(join(dir, "kit"))).toBeDefined();
    write("app/build.gradle", "apply plugin: 'org.springframework.boot'\napply plugin: 'maven-publish'\n");
    expect(libraryOf(join(dir, "app"))).toBeUndefined();
  });

  it("Maven: its own coordinates, not its parent's; mvn install", () => {
    write(
      "money/pom.xml",
      "<project><parent><groupId>org.parent</groupId><artifactId>base</artifactId></parent><groupId>com.example</groupId><artifactId>money</artifactId><dependencies><dependency><artifactId>x</artifactId></dependency></dependencies></project>",
    );
    expect(libraryOf(join(dir, "money"))).toEqual({
      publishes: ["com.example:money"],
      publishLocal: "mvn -q install -DskipTests",
    });
  });

  it("npm: a package that is not private and has an entry point; an app is not", () => {
    write("ui-kit/package.json", JSON.stringify({ name: "@acme/ui-kit", main: "dist/index.js" }));
    write("web/package.json", JSON.stringify({ name: "web", private: true, main: "x.js" }));
    expect(libraryOf(join(dir, "ui-kit"))).toEqual({ publishes: ["@acme/ui-kit"], publishLocal: "npm pack" });
    expect(libraryOf(join(dir, "web"))).toBeUndefined();
  });
});

describe("who uses it", () => {
  it("Gradle, a version catalog, a pom, package.json — and a module's build file", () => {
    write("orders-api/build.gradle", "dependencies { implementation 'com.example:common-lib:2.14.0' }\n");
    write(
      "pay/app/pom.xml",
      "<dependency><groupId>com.example</groupId><artifactId>common-lib</artifactId></dependency>",
    );
    write("cat/gradle/libs.versions.toml", 'common = { module = "com.example:common-lib", version = "2" }\n');
    write("web/package.json", JSON.stringify({ dependencies: { "@acme/ui-kit": "^1.0.0" } }));
    write("other/build.gradle", "dependencies { implementation 'com.example:other:1' }\n");
    const libs = new Map([
      ["common-lib", ["com.example:common-lib"]],
      ["ui-kit", ["@acme/ui-kit"]],
    ]);
    expect(usesOf(join(dir, "orders-api"), libs)).toEqual(["common-lib"]);
    expect(usesOf(join(dir, "pay"), libs)).toEqual(["common-lib"]);
    expect(usesOf(join(dir, "cat"), libs)).toEqual(["common-lib"]);
    expect(usesOf(join(dir, "web"), libs)).toEqual(["ui-kit"]);
    expect(usesOf(join(dir, "other"), libs)).toEqual([]);
  });

  it("a dependency kept in a Gradle script the build applies (pilot: libraries.gradle)", () => {
    write("orders-api/build.gradle", "apply from: 'libraries.gradle'\n");
    write(
      "orders-api/libraries.gradle",
      'ext.libs = [starter: "com.example.common:common-starter:$starterVersion"]\n',
    );
    const libs = new Map([["common-starter", ["com.example.common:common-starter"]]]);
    expect(usesOf(join(dir, "orders-api"), libs)).toEqual(["common-starter"]);
  });

  it("the libraries of a map: what a person declared wins over the scan", () => {
    write("common-lib/build.gradle", "plugins { id 'maven-publish' }\ngroup = 'com.example'\n");
    const map = "services:\n  common-lib:\n    publishes: [com.example:commons]\n  orders-api: {}\n";
    expect(declaredPublishes(map)).toEqual({ "common-lib": ["com.example:commons"] });
    expect(
      librariesOf(
        { "common-lib": join(dir, "common-lib"), "orders-api": join(dir, "orders-api") },
        declaredPublishes(map),
      ),
    ).toEqual(new Map([["common-lib", ["com.example:commons"]]]));
  });
});

describe("the map's entry", () => {
  const MAP = "version: 1\nservices:\n  common-lib: {}\n  orders-api:\n    uses: [common-lib]   # by hand\n";

  it("a library: its kind, what it publishes, publish-local", () => {
    const r = fillServiceEntry(MAP, "common-lib", {
      kind: "library",
      publishes: ["com.example:common-lib"],
      commands: [{ name: "publish-local", command: "./gradlew publishToMavenLocal" }],
    });
    expect(r.added).toEqual(["kind", "publishes", "tools.local.publish-local"]);
    expect(parse(r.text).services["common-lib"]).toEqual({
      kind: "library",
      publishes: ["com.example:common-lib"],
      tools: { local: { "publish-local": "./gradlew publishToMavenLocal" } },
    });
    expect(r.text).toContain("publishes: [ com.example:common-lib ]");
  });

  it("uses set by hand stays; a different scan is said, not written", () => {
    const r = fillServiceEntry(MAP, "orders-api", { uses: ["common-lib", "ui-kit"], commands: [] });
    expect(r.added).toEqual([]);
    expect(r.kept).toEqual(["uses"]);
    expect(r.text).toBe(MAP);
  });
});
