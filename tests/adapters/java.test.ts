import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JavaAdapter } from "../../src/adapters/java/adapter.ts";
import { parseJava } from "../../src/adapters/java/ast.ts";
import { JavaExtractor } from "../../src/adapters/java/extractor.ts";
import { JavaResolver } from "../../src/adapters/java/resolver.ts";
import { blankLiterals, parseJvmSource } from "../../src/adapters/java/source.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { impactOf, repoIdOf, symbolOf, updateGraph } from "../../src/knowledge/graph/update.ts";
import { classSelection, testClassOf, testRunnerOf } from "../../src/orchestration/tools/relatedTests.ts";
import { testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

const MAIN = "src/main/java/com/example/orders";
const TEST = "src/test/groovy/com/example/orders";

describe("JVM source", () => {
  it("blanks comments and literals, keeping lines", () => {
    const src = 'a // Order\n/* Slot\n */ b "Cart" \'x\' """Text\n""" c';
    const out = blankLiterals(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toMatch(/Order|Slot|Cart|Text/);
    expect(out).toMatch(/^a [\s\S]* b [\s\S]* c$/);
  });

  it("reads the package, imports, declared and used types", () => {
    const s = parseJvmSource(
      [
        "package com.example.orders;",
        "import com.example.slots.Slot;",
        "import static com.example.util.Money.format;",
        "import com.example.common.*;",
        "",
        "public abstract class OrderService extends BaseService {",
        "  private static final int MAX_ITEMS = 3; // Ignored",
        '  Slot slot; Delivery delivery = new Delivery("Nope");',
        "  private enum State { NEW }",
        "}",
      ].join("\n"),
    );
    expect(s.pkg).toBe("com.example.orders");
    expect(s.imports).toEqual([
      { name: "com.example.slots.Slot", isStatic: false, wildcard: false },
      { name: "com.example.util.Money.format", isStatic: true, wildcard: false },
      { name: "com.example.common", isStatic: false, wildcard: true },
    ]);
    expect(s.types).toEqual([
      { name: "OrderService", line: 6, exported: true, abstract: true },
      { name: "State", line: 9, exported: false, abstract: false },
    ]);
    expect(s.used).toEqual(["BaseService", "Delivery", "NEW"]);
  });
});

describe("JavaExtractor", () => {
  const x = new JavaExtractor();

  it("emits imports and same-package candidates; a runnable test is TESTED_BY what it uses", async () => {
    const svc = await x.extract(
      `${MAIN}/OrderService.java`,
      "package com.example.orders;\nimport com.example.slots.Slot;\nimport static org.junit.Assert.*;\npublic class OrderService { OrderRepository repo; }\n",
    );
    expect(svc.nodes.map((n) => [n.id, n.kind])).toEqual([
      [`${MAIN}/OrderService.java`, "Module"],
      [`${MAIN}/OrderService.java#OrderService`, "Type"],
    ]);
    expect(svc.edges.map((e) => [e.to, e.relation])).toEqual([
      ["spec:?com.example.orders.OrderRepository", "DEPENDS_ON"],
      ["spec:com.example.slots.Slot", "DEPENDS_ON"],
      ["spec:org.junit.Assert", "DEPENDS_ON"],
    ]);
    const spec = await x.extract(
      `${TEST}/OrderServiceSpecification.groovy`,
      "package com.example.orders\nclass OrderServiceSpecification extends BaseOrderSpecification {\n  def service = Mock(OrderService)\n}\n",
    );
    expect(spec.nodes[0]?.kind).toBe("Test");
    expect(spec.edges.every((e) => e.relation === "TESTED_BY")).toBe(true);
    const base = await x.extract(
      `${TEST}/BaseOrderSpecification.groovy`,
      "package com.example.orders\nabstract class BaseOrderSpecification { OrderRepository repo }\n",
    );
    // a base class of tests is no test of its own: it depends on what it uses
    expect(base.nodes[0]?.kind).toBe("Module");
    expect(base.edges.map((e) => e.relation)).toEqual(["DEPENDS_ON"]);
  });
});

describe("JavaResolver", () => {
  const files = new Set([
    "src/main/java/com/example/orders/Order.java",
    "src/test/java/com/example/orders/Samples.java",
    "billing/src/main/java/com/example/orders/Order.java",
    "README.md",
  ]);
  const r = new JavaResolver(files);
  const from = "src/main/java/com/example/orders/OrderService.java";

  it("maps classes, nested classes and static members to files of the tree", () => {
    expect(r.resolve(from, "com.example.orders.Order")).toBe("src/main/java/com/example/orders/Order.java");
    expect(r.resolve(from, "com.example.orders.Order.Line")).toBe(
      "src/main/java/com/example/orders/Order.java",
    );
    expect(r.resolve("billing/src/main/java/com/example/X.java", "com.example.orders.Order")).toBe(
      "billing/src/main/java/com/example/orders/Order.java",
    );
    expect(r.resolve(from, "?com.example.orders.Samples")).toBe(
      "src/test/java/com/example/orders/Samples.java",
    );
  });

  it("keeps a class outside the tree as its package and drops a candidate outside it", () => {
    expect(r.resolve(from, "org.springframework.web.bind.annotation.GetMapping")).toBe(
      "pkg:org.springframework.web.bind.annotation",
    );
    expect(r.resolve(from, "?com.example.orders.String")).toBeNull();
    expect(r.resolve("src/main/java/com/example/orders/Order.java", "?com.example.orders.Order")).toBeNull();
  });
});

describe("JVM graph of a project", () => {
  let sb: Sandbox;
  let rt: Runtime | undefined;
  const write = (rel: string, content: string) => {
    mkdirSync(join(sb.project, rel, ".."), { recursive: true });
    writeFileSync(join(sb.project, rel), content);
  };
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: sb.project,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  beforeEach(() => {
    sb = sandbox();
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    write("build.gradle", "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
    write(`${MAIN}/Order.java`, "package com.example.orders;\npublic class Order {}\n");
    write(
      `${MAIN}/OrderRepository.java`,
      "package com.example.orders;\npublic interface OrderRepository { Order find(); }\n",
    );
    write(
      `${MAIN}/web/OrderController.java`,
      "package com.example.orders.web;\nimport com.example.orders.*;\npublic class OrderController { OrderRepository repo; }\n",
    );
    write(
      `${TEST}/BaseOrderSpecification.groovy`,
      "package com.example.orders\nabstract class BaseOrderSpecification { OrderRepository repo }\n",
    );
    write(
      `${TEST}/FindOrderSpecification.groovy`,
      "package com.example.orders\nclass FindOrderSpecification extends BaseOrderSpecification {}\n",
    );
    write(
      "src/test/java/com/example/orders/web/OrderControllerTest.java",
      "package com.example.orders.web;\nimport org.junit.jupiter.api.Test;\nclass OrderControllerTest { OrderController c; }\n",
    );
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    sb.cleanup();
  });

  it("detects a Spring Gradle build", async () => {
    const a = new JavaAdapter();
    expect(await a.detect(sb.project)).toEqual({
      detected: true,
      stacks: ["gradle", "java", "spring"],
      evidence: ["build.gradle"],
    });
    expect(a.defaultCommands().test).toBe("./gradlew test");
  });

  it("reaches the users of an interface from its implementation, and a controller's MockMvc test by its URL", async () => {
    write(
      `${MAIN}/OrderService.java`,
      "package com.example.orders;\npublic interface OrderService { Order find(String id); }\n",
    );
    write(
      `${MAIN}/OrderServiceImpl.java`,
      "package com.example.orders;\n@Service class OrderServiceImpl implements OrderService { OrderRepository repo; public Order find(String id) { return repo.find(); } }\n",
    );
    write(
      `${MAIN}/LegacyOrderService.java`,
      "package com.example.orders;\nclass LegacyOrderService implements OrderService { public Order find(String id) { return null; } }\n",
    );
    write(
      `${MAIN}/web/OrderApi.java`,
      'package com.example.orders.web;\nimport com.example.orders.OrderService;\n@RestController @RequestMapping("/api/orders")\npublic class OrderApi {\n  private final OrderService service;\n  @GetMapping("/{id}")\n  public Order get(@PathVariable String id) { return service.find(id); }\n}\n',
    );
    write(
      "src/test/java/com/example/orders/web/OrderApiIT.java",
      'package com.example.orders.web;\nclass OrderApiIT { static final String URL = "/api/orders/"; void get() { mockMvc.perform(get(URL + "42")); mockMvc.perform(get("/api/orders/$id")); } }\n',
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "api"]);
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const { snapshot } = await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        {
          from: `${MAIN}/web/OrderApi.java`,
          to: "src/test/java/com/example/orders/web/OrderApiIT.java",
          relation: "TESTED_BY",
        },
        {
          from: `${MAIN}/OrderServiceImpl.java#OrderServiceImpl`,
          to: `${MAIN}/OrderService.java#OrderService`,
          relation: "IMPLEMENTS",
        },
        {
          from: `${MAIN}/web/OrderApi.java#OrderApi.get/1`,
          to: `${MAIN}/OrderService.java#OrderService.find/1`,
          relation: "CALLS",
        },
      ]),
    );
    const impact = impactOf(snapshot, [`${MAIN}/OrderServiceImpl.java`]);
    // the controller holds the interface; the other implementation is no user of it
    expect(impact.dependents.map((d) => d.file)).toContain(`${MAIN}/web/OrderApi.java`);
    expect(impact.dependents.map((d) => d.file)).not.toContain(`${MAIN}/LegacyOrderService.java`);
    expect(impact.tests).toContain("src/test/java/com/example/orders/web/OrderApiIT.java");
    // one call instead of a search: the interface's implementations, the implementation's callers through it
    const [iface] = symbolOf(snapshot, "OrderService");
    expect(iface?.subtypes.map((r) => r.id)).toEqual([
      `${MAIN}/LegacyOrderService.java#LegacyOrderService`,
      `${MAIN}/OrderServiceImpl.java#OrderServiceImpl`,
    ]);
    const [impl] = symbolOf(snapshot, "OrderServiceImpl.find");
    expect(impl).toMatchObject({ id: `${MAIN}/OrderServiceImpl.java#OrderServiceImpl.find/1`, line: 2 });
    expect(impl?.callers).toEqual([
      {
        id: `${MAIN}/web/OrderApi.java#OrderApi.get/1`,
        file: `${MAIN}/web/OrderApi.java`,
        line: 6,
        via: "OrderService.find/1",
      },
    ]);
  });

  it("finds the tests of a change through a base test class and a wildcard import", async () => {
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const { snapshot } = await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { from: `${MAIN}/OrderRepository.java`, to: `${MAIN}/Order.java`, relation: "DEPENDS_ON" },
        {
          from: `${MAIN}/web/OrderController.java`,
          to: `${MAIN}/OrderRepository.java`,
          relation: "DEPENDS_ON",
        },
        {
          from: `${TEST}/BaseOrderSpecification.groovy`,
          to: `${MAIN}/OrderRepository.java`,
          relation: "DEPENDS_ON",
        },
        {
          from: `${TEST}/BaseOrderSpecification.groovy`,
          to: `${TEST}/FindOrderSpecification.groovy`,
          relation: "TESTED_BY",
        },
      ]),
    );
    // candidates the tree does not have leave no trace
    expect(snapshot.edges.some((e) => e.to.includes("?") || e.to.includes("Order.find"))).toBe(false);
    expect(impactOf(snapshot, [`${MAIN}/Order.java`]).tests).toEqual([
      `${TEST}/FindOrderSpecification.groovy`,
      "src/test/java/com/example/orders/web/OrderControllerTest.java",
    ]);
  });
});

describe("related tests of a class-taking runner", () => {
  it("knows the runner by its command, and a test file by its class", () => {
    expect(testRunnerOf("./gradlew test")).toBe("gradle");
    expect(testRunnerOf("cd svc && ./gradlew :svc:test")).toBe("gradle");
    expect(testRunnerOf("./gradlew test jacocoTestReport")).toBeUndefined();
    expect(testRunnerOf("mvn -q test")).toBe("maven");
    expect(testRunnerOf("yarn jest")).toBe("jest");
    expect(testClassOf("svc/src/test/groovy/a/b/OrderSpecification.groovy")).toBe("a.b.OrderSpecification");
    expect(testClassOf("src/orders/order.test.ts")).toBeUndefined();
  });

  it("selects the classes, skips when none covers the change and runs all without a graph", () => {
    expect(classSelection("gradle", ["src/test/java/a/BTest.java", "src/test/java/a/ATest.java"])).toEqual({
      args: "--tests a.ATest --tests a.BTest",
    });
    expect(classSelection("maven", ["src/test/java/a/ATest.java"])).toEqual({
      args: "-Dtest=a.ATest -Dsurefire.failIfNoSpecifiedTests=false",
    });
    expect(classSelection("gradle", [])).toEqual({ skip: "no test covers the changed code (project graph)" });
    expect(classSelection("gradle", undefined)).toBeUndefined();
  });
});

describe("Spring contracts in the graph", () => {
  const x = new JavaExtractor();

  it("reads endpoints under the class route, Feign calls and Kafka listeners", async () => {
    const ctl = await x.extract(
      `${MAIN}/web/OrderController.java`,
      [
        "package com.example.orders.web;",
        '// @GetMapping("/commented")',
        '@RequestMapping("/api/orders")',
        "public class OrderController {",
        '  @GetMapping("/{id}")',
        '  public Order get(@PathVariable String id, @RequestHeader("X-User") String user) { return null; }',
        '  @PostMapping(value = {"", "/new"}, headers = "X-V=2")',
        "  @ResponseStatus(HttpStatus.CREATED)",
        "  Order create(@RequestBody Order o) { return o; }",
        '  @RequestMapping(method = RequestMethod.PUT, value = "/{id}/slot")',
        "  void slot() {}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a Spring placeholder in Java source
        '  @KafkaListener(topics = "${orders.topics.paid.name}", groupId = "g")',
        "  void onPaid(String m) {}",
        "}",
      ].join("\n"),
    );
    const meta = ctl.nodes
      .filter((n) => n.kind === "Endpoint" || n.kind === "Event")
      .map((n) => [n.id.split("#")[1], n.metadata]);
    expect(meta).toEqual([
      [
        "GET /api/orders/{id}",
        { method: "GET", path: "/api/orders/{id}", handler: "OrderController.get", direction: "in", line: 5 },
      ],
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a Spring placeholder in Java source
        "listens ${orders.topics.paid.name}",
        { role: "listens", property: "orders.topics.paid.name", handler: "OrderController.onPaid", line: 12 },
      ],
      [
        "POST /api/orders",
        { method: "POST", path: "/api/orders", handler: "OrderController.create", direction: "in", line: 7 },
      ],
      [
        "POST /api/orders/new",
        {
          method: "POST",
          path: "/api/orders/new",
          handler: "OrderController.create",
          direction: "in",
          line: 7,
        },
      ],
      [
        "PUT /api/orders/{id}/slot",
        {
          method: "PUT",
          path: "/api/orders/{id}/slot",
          handler: "OrderController.slot",
          direction: "in",
          line: 10,
        },
      ],
    ]);
    const client = await x.extract(
      `${MAIN}/client/SlotsClient.java`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Spring placeholder in Java source
      'package com.example.orders.client;\n@FeignClient(name = "slots", url = "${slots.url}")\npublic interface SlotsClient {\n  @GetMapping("/slots/{zone}")\n  List<Slot> slots(@PathVariable String zone);\n}\n',
    );
    expect(client.nodes.find((n) => n.kind === "Endpoint")?.metadata).toEqual({
      method: "GET",
      path: "/slots/{zone}",
      handler: "SlotsClient.slots",
      direction: "out",
      client: "slots",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the client's address as the code names it
      url: "${slots.url}",
      line: 4,
    });
  });

  it("marks a base controller's endpoints inherited and its subclass's route", async () => {
    const base = await x.extract(
      `${MAIN}/web/BaseAdminController.java`,
      'package com.example.orders.web;\npublic abstract class BaseAdminController<T> {\n  @DeleteMapping("/{id}")\n  void remove() {}\n}\n',
    );
    expect(base.nodes.find((n) => n.kind === "Endpoint")?.metadata).toMatchObject({
      path: "/{id}",
      inherited: true,
    });
    const sub = await x.extract(
      `${MAIN}/web/OrderAdminController.java`,
      'package com.example.orders.web;\n@RequestMapping(\n  "/admin/orders")\npublic class OrderAdminController extends BaseAdminController<Order> {}\n',
    );
    expect(sub.nodes[0]?.metadata).toMatchObject({ route: "/admin/orders", extends: "BaseAdminController" });
  });

  it("reads the topics of a Spring config, each profile's, and no other YAML", async () => {
    const yml = [
      "orders:",
      "  topics:",
      "    paid:",
      "      name: orders.paid",
      "      group-id: orders-svc",
      "spring:",
      "  cloud:",
      "    stream:",
      "      bindings:",
      "        slots-out-0:",
      "          destination: slots.changed",
      "---",
      "orders:",
      "  topics:",
      "    paid:",
      "      name: orders.paid.test",
      "    refunds: [orders.refund.a, orders.refund.b]",
    ].join("\n");
    const facts = await x.extract("src/main/resources/application.yml", yml);
    expect(
      facts.nodes
        .filter((n) => n.kind === "Event")
        .map((n) => [n.metadata?.property, n.metadata?.topic, n.metadata?.line]),
    ).toEqual([
      ["orders.topics.paid.name", "orders.paid", 4],
      ["orders.topics.refunds.0", "orders.refund.a", 17],
      ["orders.topics.refunds.1", "orders.refund.b", 17],
      ["spring.cloud.stream.bindings.slots-out-0.destination", "slots.changed", 11],
    ]);
    expect(await x.extract(".github/workflows/ci.yml", "topics: [a]\n")).toEqual({ nodes: [], edges: [] });
  });
});

describe("Java syntax (tree-sitter)", () => {
  const SRC = [
    "package com.example.orders;",
    "import com.example.slots.SlotRepository;",
    "import static com.example.util.Money.format;",
    "import com.example.common.*;",
    "@Service @RequiredArgsConstructor",
    "public class OrderServiceImpl extends BaseService implements OrderService {",
    "  private final OrderRepository repo;",
    "  private final SlotRepository slots;",
    "  @Override public OrderDto find(String id) {",
    "    var order = new Order(id);",
    "    Slot slot = slots.next(order);",
    "    audit(order);",
    "    this.repo.save(order);",
    "    Mapper.toDto(order);",
    "    repo.findById(id).orElseThrow();",
    "    STATUS.equals(id);",
    "    return list.stream().map(Mapper::toDto);",
    "  }",
    "  static class Cache { void put(Order o) { o.getId(); } }",
    "}",
  ].join("\n");

  it("reads types, members and the calls whose receiver the file types", async () => {
    const f = await parseJava(SRC);
    expect(f).toMatchObject({
      pkg: "com.example.orders",
      imports: ["com.example.slots.SlotRepository"],
      wildcards: ["com.example.common"],
      staticImports: ["com.example.util.Money.format"],
      errors: false,
    });
    expect(f.types.map((t) => [t.path, t.extends, t.implements, t.annotations])).toEqual([
      ["OrderServiceImpl", ["BaseService"], ["OrderService"], ["Service", "RequiredArgsConstructor"]],
      ["OrderServiceImpl.Cache", [], [], []],
    ]);
    const find = f.types[0]?.methods[0];
    expect(find?.key).toBe("find/1");
    expect(find?.calls.map((c) => `${c.type}#${c.method}/${c.arity}`)).toEqual([
      "Mapper#toDto/-1",
      "Mapper#toDto/1",
      "Order#<init>/1",
      "OrderRepository#findById/1",
      "OrderRepository#save/1",
      "OrderServiceImpl#audit/1",
      "SlotRepository#next/1",
    ]);
    expect(f.types[1]?.methods[0]?.calls).toEqual([{ type: "Order", method: "getId", arity: 0 }]);
  });

  it("resolves calls to methods of the tree, through supertypes, and drops library calls", async () => {
    const x = new JavaExtractor();
    const files = {
      [`${MAIN}/OrderServiceImpl.java`]: SRC,
      [`${MAIN}/OrderService.java`]:
        "package com.example.orders;\npublic interface OrderService extends Auditable { OrderDto find(String id); }\n",
      [`${MAIN}/Auditable.java`]:
        "package com.example.orders;\ninterface Auditable { default void audit(Order o) {} }\n",
      [`${MAIN}/BaseService.java`]: "package com.example.orders;\nabstract class BaseService {}\n",
      [`${MAIN}/OrderRepository.java`]:
        "package com.example.orders;\nimport org.springframework.data.repository.CrudRepository;\ninterface OrderRepository extends CrudRepository<Order, String> { }\n",
      [`${MAIN}/Order.java`]:
        "package com.example.orders;\nimport lombok.Data;\n@Data public class Order { private String id; public Order(String id) { this.id = id; } }\n",
      "src/main/java/com/example/slots/SlotRepository.java":
        "package com.example.slots;\npublic class SlotRepository { public Slot next(Object o) { return null; } }\n",
    };
    const nodes = [];
    const raw = [];
    for (const [f, c] of Object.entries(files)) {
      const facts = await x.extract(f, c);
      nodes.push(...facts.nodes);
      raw.push(...facts.edges);
    }
    const r = x.createResolver("", new Set(Object.keys(files)), nodes);
    const resolved = raw
      .filter((e) => e.from.startsWith(`${MAIN}/OrderServiceImpl.java#`) && e.relation !== "DEPENDS_ON")
      .map((e) => [e.relation, e.to.slice(5), r.resolve(e.from, e.to.slice(5))]);
    expect(resolved).toEqual([
      // a getter Lombok generates: the class
      ["CALLS", "call:Order#getId/0", `${MAIN}/Order.java#Order`],
      ["CALLS", "call:Mapper#toDto/-1", null],
      ["CALLS", "call:Mapper#toDto/1", null],
      ["CALLS", "call:Order#<init>/1", `${MAIN}/Order.java#Order.<init>/1`],
      // inherited from the library: the class itself
      ["CALLS", "call:OrderRepository#findById/1", `${MAIN}/OrderRepository.java#OrderRepository`],
      ["CALLS", "call:OrderRepository#save/1", `${MAIN}/OrderRepository.java#OrderRepository`],
      // a default method of an interface of an interface
      ["CALLS", "call:OrderServiceImpl#audit/1", `${MAIN}/Auditable.java#Auditable.audit/1`],
      [
        "CALLS",
        "call:SlotRepository#next/1",
        "src/main/java/com/example/slots/SlotRepository.java#SlotRepository.next/1",
      ],
      ["EXTENDS", "type:BaseService", `${MAIN}/BaseService.java#BaseService`],
      ["IMPLEMENTS", "type:OrderService", `${MAIN}/OrderService.java#OrderService`],
    ]);
    expect(r.resolve(`${MAIN}/OrderRepository.java#OrderRepository`, "type:CrudRepository")).toBe(
      "pkg:org.springframework.data.repository.CrudRepository",
    );
  });
});

describe("fileSelection: vitest's filters", () => {
  it("the covering test files; none — skip; too many — the whole suite", async () => {
    const { fileSelection, MAX_TEST_FILES } = await import("../../src/orchestration/tools/relatedTests.ts");
    expect(fileSelection(undefined)).toBeUndefined();
    expect(fileSelection([])).toEqual({ skip: "no test covers the changed code (project graph)" });
    expect(fileSelection(["src/a.test.ts"])).toEqual({ files: ["src/a.test.ts"] });
    expect(
      fileSelection(Array.from({ length: MAX_TEST_FILES + 1 }, (_, i) => `t${i}.test.ts`)),
    ).toBeUndefined();
  });
});
