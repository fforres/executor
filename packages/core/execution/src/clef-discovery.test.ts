import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { askClef, CLEF_FLASH_MODEL, CLEF_MODEL, type ClefAiBinding } from "./clef";
import { makeClefRankingCache, makeClefToolDiscoveryProvider } from "./clef-discovery";
import type { ToolDiscoveryInput } from "./tool-invoker";

interface ClefRequest {
  readonly model: string;
  readonly state: string;
  readonly questions: Record<string, { type: string; instructions: string }>;
  readonly gatewayId: string | undefined;
}

/** A fake Workers AI binding that answers from a probability table by tool path. */
const fakeAi = (
  probabilities: Readonly<Record<string, number>>,
  options: { readonly failWhen?: (request: ClefRequest) => boolean } = {},
) => {
  const requests: ClefRequest[] = [];
  const ai: ClefAiBinding = {
    run: (model, inputs, runOptions) => {
      const body = inputs as Pick<ClefRequest, "state" | "questions">;
      const request = { model, ...body, gatewayId: runOptions?.gateway?.id };
      requests.push(request);
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: the fake binding rejects like a failed Workers AI call
      if (options.failWhen?.(request)) return Promise.reject(new Error("clef down"));
      return Promise.resolve({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            { type: "noul", noul: probabilities[id] ?? 0 },
          ]),
        ),
        usage: {},
      });
    },
  };
  return { ai, requests };
};

const toolRow = (integration: string, name: string, description?: string) => ({
  address: `tools.${integration}.org.main.${name}`,
  integration,
  name,
  description,
});

const executorWith = (tools: readonly Record<string, unknown>[]) =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: a test double for the one method the provider calls
  ({ tools: { list: () => Effect.succeed(tools) } }) as unknown as ToolDiscoveryInput["executor"];

const input = (tools: readonly Record<string, unknown>[], query = "show my open tasks") => ({
  executor: executorWith(tools),
  query,
  limit: 50,
  offset: 0,
});

const manyTools = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    toolRow("svc", `tool${index}`, `does thing ${index}`),
  );

describe("makeClefToolDiscoveryProvider", () => {
  it.effect("ranks by Clef probability, descending, dropping answers below 0.3", () =>
    Effect.gen(function* () {
      const { ai } = fakeAi({
        "linear.org.main.issues_list": 0.92,
        "github.org.main.pulls_list": 0.31,
        "slack.org.main.post": 0.29,
        "notion.org.main.pages": 0.55,
      });
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      const page = yield* provider.searchTools(
        input([
          toolRow("slack", "post"),
          toolRow("github", "pulls_list"),
          toolRow("linear", "issues_list"),
          toolRow("notion", "pages"),
        ]),
      );
      expect(page.items.map((item) => [item.path, item.score])).toEqual([
        ["linear.org.main.issues_list", 92],
        ["notion.org.main.pages", 55],
        ["github.org.main.pulls_list", 31],
      ]);
      expect(page.ranked).toBe(true);
    }),
  );

  it.effect("splits the catalog into shards of at most 64 tools, one request each", () =>
    Effect.gen(function* () {
      const { ai, requests } = fakeAi({});
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      yield* provider.searchTools(input(manyTools(150)));
      expect(requests.map((request) => Object.keys(request.questions).length).sort()).toEqual([
        22, 64, 64,
      ]);
    }),
  );

  it.effect("puts the query and one id: description line per tool in the state", () =>
    Effect.gen(function* () {
      const longDescription = "x".repeat(500);
      const { ai, requests } = fakeAi({});
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      yield* provider.searchTools(
        input([toolRow("linear", "issues_list", longDescription)], "my tasks"),
      );
      const state = requests[0]!.state;
      expect(state).toContain("Request: my tasks");
      expect(state).toContain(`linear.org.main.issues_list: ${"x".repeat(300)}\n`.trimEnd());
      expect(state).not.toContain("x".repeat(301));
    }),
  );

  it.effect("merges ranked tools across shards into one ordering", () =>
    Effect.gen(function* () {
      const { ai } = fakeAi({
        "svc.org.main.tool5": 0.6,
        "svc.org.main.tool70": 0.9,
        "svc.org.main.tool140": 0.75,
      });
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      const page = yield* provider.searchTools(input(manyTools(150)));
      expect(page.items.map((item) => item.path)).toEqual([
        "svc.org.main.tool70",
        "svc.org.main.tool140",
        "svc.org.main.tool5",
      ]);
    }),
  );

  it.effect("falls back to lexical matches for a failed shard and flags ranked: false", () =>
    Effect.gen(function* () {
      const { ai } = fakeAi(
        { "svc.org.main.tool66": 0.9 },
        { failWhen: (request) => "svc.org.main.tool0" in request.questions },
      );
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      const page = yield* provider.searchTools(
        input(
          [
            ...manyTools(70).map((tool) =>
              tool.name === "tool3" ? toolRow("svc", "tasks_list", "list open tasks") : tool,
            ),
          ],
          "tasks",
        ),
      );
      const paths = page.items.map((item) => item.path);
      expect(paths[0]).toBe("svc.org.main.tool66");
      expect(paths).toContain("svc.org.main.tasks_list");
      expect(page.ranked).toBe(false);
    }),
  );

  it.effect("serves lexical results flagged ranked: false when there is no AI binding", () =>
    Effect.gen(function* () {
      const provider = makeClefToolDiscoveryProvider({ subject: "me" });
      const page = yield* provider.searchTools(
        input([toolRow("linear", "issues_list", "List Linear issues")], "linear issues"),
      );
      expect(page.items.map((item) => item.path)).toEqual(["linear.org.main.issues_list"]);
      expect(page.ranked).toBe(false);
    }),
  );

  it.effect("caches a ranking per subject, scope and query, and expires it", () =>
    Effect.gen(function* () {
      let clock = 1_000;
      const cache = makeClefRankingCache(() => clock);
      const { ai, requests } = fakeAi({ "svc.org.main.tool1": 0.8 });
      const provider = (subject: string) =>
        makeClefToolDiscoveryProvider({ clef: { ai }, subject, cache, now: () => clock });
      const tools = manyTools(3);

      yield* provider("alice").searchTools(input(tools));
      yield* provider("alice").searchTools(input(tools));
      expect(requests).toHaveLength(1);

      yield* provider("alice").searchTools({ ...input(tools), scope: "integration=svc" });
      yield* provider("bob").searchTools(input(tools));
      yield* provider("alice").searchTools(input(tools, "another query"));
      expect(requests).toHaveLength(4);

      clock += 61_000;
      yield* provider("alice").searchTools(input(tools));
      expect(requests).toHaveLength(5);
    }),
  );

  it.effect("pages a cached ranking without asking Clef again", () =>
    Effect.gen(function* () {
      const cache = makeClefRankingCache();
      const { ai, requests } = fakeAi({
        "svc.org.main.tool0": 0.9,
        "svc.org.main.tool1": 0.8,
        "svc.org.main.tool2": 0.7,
      });
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me", cache });
      const tools = manyTools(3);
      const first = yield* provider.searchTools({ ...input(tools), limit: 2 });
      const second = yield* provider.searchTools({ ...input(tools), limit: 2, offset: 2 });
      expect(first.items.map((item) => item.path)).toEqual([
        "svc.org.main.tool0",
        "svc.org.main.tool1",
      ]);
      expect(second.items.map((item) => item.path)).toEqual(["svc.org.main.tool2"]);
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("only considers tools inside the requested namespace", () =>
    Effect.gen(function* () {
      const { ai, requests } = fakeAi({});
      const provider = makeClefToolDiscoveryProvider({ clef: { ai }, subject: "me" });
      yield* provider.searchTools({
        ...input([toolRow("linear", "a"), toolRow("github", "b")]),
        namespace: "github",
      });
      expect(Object.keys(requests[0]!.questions)).toEqual(["github.org.main.b"]);
    }),
  );
});

describe("askClef", () => {
  it.effect("calls the flash model through the configured gateway by default", () =>
    Effect.gen(function* () {
      const { ai, requests } = fakeAi({ q: 0.5 });
      const answers = yield* askClef({
        config: { ai, gatewayId: "posse-gw" },
        state: "s",
        questions: [{ id: "q", instructions: "is it?" }],
      });
      expect(answers).toEqual([{ id: "q", probability: 0.5 }]);
      expect(requests[0]).toMatchObject({ model: CLEF_FLASH_MODEL, gatewayId: "posse-gw" });
    }),
  );

  it.effect("uses the configured model", () =>
    Effect.gen(function* () {
      const { ai, requests } = fakeAi({});
      yield* askClef({
        config: { ai, model: CLEF_MODEL },
        state: "s",
        questions: [{ id: "q", instructions: "is it?" }],
      });
      expect(requests[0]?.model).toBe("@cf/cloudflare/clef");
      expect(requests[0]?.gatewayId).toBeUndefined();
    }),
  );

  it.effect("rejects more than 64 questions and a response without answers", () =>
    Effect.gen(function* () {
      const { ai } = fakeAi({});
      const tooMany = yield* askClef({
        config: { ai },
        state: "s",
        questions: Array.from({ length: 65 }, (_, index) => ({
          id: `q${index}`,
          instructions: "?",
        })),
      }).pipe(Effect.flip);
      expect(tooMany.message).toContain("at most 64");

      const empty = yield* askClef({
        config: { ai: { run: () => Promise.resolve({ nothing: true }) } },
        state: "s",
        questions: [{ id: "q", instructions: "?" }],
      }).pipe(Effect.flip);
      expect(empty.message).toBe("Clef response carried no answers");
    }),
  );
});
