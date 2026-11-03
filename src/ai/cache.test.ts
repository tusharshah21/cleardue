import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { cacheScopeFor } from "./cache";
import { classifyReply, scopeCheck, type ThreadMessage } from "./tasks";
import { replayModel } from "./replay";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { gen } from "./test-utils";

const store = vi.hoisted(() => new Map<string, { output: unknown }>());
vi.mock("@/lib/db", () => ({
  db: {
    aiCache: {
      findUnique: async ({ where }: { where: { freelancerId_key: { freelancerId: string; key: string } } }) => store.get(`${where.freelancerId_key.freelancerId}:${where.freelancerId_key.key}`) ?? null,
      upsert: async ({ create }: { create: { freelancerId: string; key: string; output: unknown } }) => void store.set(`${create.freelancerId}:${create.key}`, { output: create.output }),
    },
  },
}));

const good = { reason: "awaiting_approval", confidence: 0.9, evidence: ["waiting on finance sign-off"], promisedDate: null, approverEmail: null, summary: "Stuck in finance approval." };
const textOf = (v: unknown) => gen([{ type: "text", text: JSON.stringify(v) }]);
const thread = (body: string): ThreadMessage[] => [{ from: "client", at: new Date("2026-11-02"), body }];
const input = (body: string, cacheScope: Parameters<typeof classifyReply>[1]["cacheScope"]) => ({
  clientName: "Acme Labs",
  invoiceSummary: "$2,400 outstanding",
  thread: thread(body),
  now: new Date("2026-11-03T09:00:00Z"),
  cacheScope,
});
const demo = { freelancerId: "f1", seed: "abc" };
const reply = "Sorry, waiting on finance sign-off, should clear next week.";

beforeEach(() => {
  store.clear();
  vi.stubEnv("DEMO_EMAIL", "demo@cleardue.app");
});

describe("response cache", () => {
  it("stores the first live result and reuses it for identical inputs, labelled cached", async () => {
    const live = new MockLanguageModelV4({ doGenerate: textOf(good) });
    const first = await classifyReply(live, input(reply, demo));
    expect(first).toMatchObject({ fallback: false, cached: false });
    const second = await classifyReply(live, input(reply, demo));
    expect(live.doGenerateCalls).toHaveLength(1);
    expect(second).toMatchObject({ fallback: false, cached: true });
    expect(second.value.reason).toBe("awaiting_approval");
  });

  it("misses when the reply, the day, the model or the seed changes", async () => {
    const live = new MockLanguageModelV4({ doGenerate: textOf(good) });
    await classifyReply(live, input(reply, demo));
    await classifyReply(live, input(`${reply} Thanks.`, demo));
    await classifyReply(live, { ...input(reply, demo), now: new Date("2026-11-04T09:00:00Z") });
    await classifyReply(live, input(reply, { ...demo, seed: "other-stories" }));
    await classifyReply(new MockLanguageModelV4({ modelId: "other-model", doGenerate: textOf(good) }), input(reply, demo));
    expect(live.doGenerateCalls).toHaveLength(4);
  });

  it("is scoped to the demo freelancer: nobody else gets a cache", async () => {
    expect(await cacheScopeFor({ id: "f2", email: "someone@else.test" })).toBeNull();
    expect(await cacheScopeFor(null)).toBeNull();
    vi.stubEnv("DEMO_MODE", "true"); // recordings are replayed instead
    expect(await cacheScopeFor({ id: "f1", email: "demo@cleardue.app" })).toBeNull();
    vi.stubEnv("DEMO_MODE", "false");
    expect(await cacheScopeFor({ id: "f1", email: "demo@cleardue.app" })).toMatchObject({ freelancerId: "f1" });
    const live = new MockLanguageModelV4({ doGenerate: textOf(good) });
    await classifyReply(live, input(reply, null));
    await classifyReply(live, input(reply, null));
    expect(live.doGenerateCalls).toHaveLength(2);
    expect(store.size).toBe(0);
  });

  it("never stores a replayed result or a fallback", async () => {
    const replaying = replayModel(DEMO_FIXTURES, new MockLanguageModelV4({ doGenerate: textOf(good) }));
    const r = await classifyReply(replaying, input(reply, demo));
    expect(r.replayed).toBe(true);
    expect(store.size).toBe(0);
    const failing = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("boom")) });
    expect((await classifyReply(failing, input("something unrelated", demo))).fallback).toBe(true);
    expect(store.size).toBe(0);
  });

  it("caches the scope check too, keyed on the scope text and the request", async () => {
    const verdict = { verdict: "OUT_OF_SCOPE", quotedClauses: ["Out of scope: copywriting"], reasoning: "Copywriting is excluded.", estimatedHours: 4, suggestedLineItem: null };
    const live = new MockLanguageModelV4({ doGenerate: textOf(verdict) });
    const scope = "1. Design.\n5. Out of scope: copywriting";
    await scopeCheck(live, { scope, request: "Write the copy", cacheScope: demo });
    const again = await scopeCheck(live, { scope, request: "Write the copy", cacheScope: demo });
    expect(live.doGenerateCalls).toHaveLength(1);
    expect(again.cached).toBe(true);
  });
});
