import { describe, expect, it } from "vitest";
import { crossNoteHtml, newTaskHtml, placesOf, workflowOfChoice } from "../../src/ui/newTask.ts";

const META = {
  root: "/home/dev/code/shop-knowledge",
  repos: {
    "orders-api": "/home/dev/code/orders-api",
    "common-lib": "/home/dev/code/common-lib",
    "web-portal": "/home/dev/code/web-portal",
  },
  kinds: { "orders-api": "backend", "common-lib": "library" },
};

describe("New task", () => {
  it("places: all services, the services of the map on this machine, other repositories with runs", () => {
    const places = placesOf({
      repos: [
        "/home/dev/code/orders-api",
        META.root,
        "/home/dev/code/common-lib",
        "/home/dev/code/tools-scripts",
      ],
      meta: META,
    });
    expect(places.map((p) => [p.group, p.name, p.kind ?? ""])).toEqual([
      ["across", "All services", ""],
      ["service", "common-lib", "library"],
      ["service", "orders-api", "backend"],
      ["other", "tools-scripts", ""],
    ]);
    expect(places[0]?.services).toBe(3);
    // no knowledge repository: the repositories with runs
    expect(placesOf({ repos: ["/a/one", "/a/two"] }).map((p) => [p.group, p.name])).toEqual([
      ["other", "one"],
      ["other", "two"],
    ]);
  });

  it("how far runs as: Implement in all services is the task across services; Fix there is none", () => {
    expect(workflowOfChoice("sdd", true)).toBe("sdd-cross");
    expect(workflowOfChoice("fix", true)).toBeUndefined();
    expect(workflowOfChoice("research", true)).toBe("research");
    expect(workflowOfChoice("sdd", false)).toBe("sdd");
  });

  it("the form: the place chosen, the button named after the action and the place; one place has no list", () => {
    const places = placesOf({ repos: ["/home/dev/code/orders-api", META.root], meta: META });
    const one = String(
      newTaskHtml(
        { places, current: "/home/dev/code/orders-api", launches: [], homeDir: "/home/dev" },
        { token: "t" },
      ),
    );
    expect(one).toContain('<summary class="pick" title="Where it runs" aria-label="Where it runs">');
    expect(one).toContain("~/code/orders-api");
    expect(one).toContain("data-go>Run</button>");
    expect(one).toContain("<b>Specification</b> — up to an approved spec");
    // autonomous runs are offered, marked as experimental
    expect(one).toContain(
      '<input type="checkbox" name="autonomous" value="1"> Autonomous <span class="pill wait">experimental</span>',
    );
    // research alone is not offered: a spec starts with it (Ask is for questions)
    expect(one).not.toContain('value="research"');
    expect(one).not.toContain(" disabled>");
    const alone = String(
      newTaskHtml(
        { places: placesOf({ repos: ["/a/one"] }), current: "/a/one", launches: [], homeDir: "" },
        { token: "t" },
      ),
    );
    expect(alone).toContain('<input type="hidden" name="repo" value="/a/one">');
    expect(alone).not.toContain('<details class="where"');
  });

  it("the note on linked services: what it noticed, and a link that changes only Where", () => {
    const note = String(
      crossNoteHtml(
        [
          { service: "notifications-worker", by: "reads order.created" },
          { service: "orders-api", by: "its name" },
        ],
        {
          kind: "topic",
          what: "order.created",
          producer: "orders-api",
          consumer: "notifications-worker",
          endpointFound: true,
        },
        META.root,
      ),
    );
    expect(note).toContain(
      "The task names <b>notifications-worker</b> and <b>orders-api</b>, linked by <code>order.created</code>. If both must change",
    );
    expect(note).toContain(`data-cross data-repo="${META.root}">All services</button>`);
  });
});
