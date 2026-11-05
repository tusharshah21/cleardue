import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { clearAiCache, readCache, writeCache } from "./cache";
import { structured } from "./structured";
import { gen } from "./test-utils";

const rows = vi.hoisted(() => [] as { id: string; output: unknown }[]);
vi.mock("@/lib/db", () => ({
  db: {
    aiCache: {
      findUnique: async () => rows[0] ?? null,
      findMany: async () => rows.map((r) => ({ ...r })),
      deleteMany: async ({ where }: { where?: { id?: { in: string[] } } }) => {
        const gone = where?.id ? rows.filter((r) => where.id!.in.includes(r.id)) : [...rows];
        gone.forEach((g) => rows.splice(rows.indexOf(g), 1));
        return { count: gone.length };
      },
      upsert: async ({ create }: { create: { key: string; output: unknown } }) => void rows.push({ id: create.key, output: create.output }),
    },
  },
}));

const schema = z.object({ note: z.string() });
const BAD = "I предложed a two-part payment plan and sent the client a matching message.";
const text = (v: unknown) => gen([{ type: "text", text: JSON.stringify(v) }]);
const scope = { freelancerId: "f1", seed: "s" };

describe("structured output in another script", () => {
  it("retries once, and never caches the foreign answer", async () => {
    rows.length = 0;
    const model = new MockLanguageModelV4({ doGenerate: [text({ note: BAD }), text({ note: "I proposed a plan." })] });
    const r = await structured({ model, schema, system: "s", prompt: "p", fallback: () => ({ note: "fb" }), cache: { scope, task: "t", parts: ["x"] } });
    expect(r.value.note).toBe("I proposed a plan.");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/предложed/);
  });

  it("uses the fallback when both tries are foreign, and stores nothing", async () => {
    rows.length = 0;
    const model = new MockLanguageModelV4({ doGenerate: [text({ note: BAD }), text({ note: BAD })] });
    const r = await structured({ model, schema, system: "s", prompt: "p", fallback: () => ({ note: "fb" }), cache: { scope, task: "t", parts: ["x"] } });
    expect(r.fallback).toBe(true);
    expect(rows).toHaveLength(0);
  });
});

describe("the response cache", () => {
  const model = new MockLanguageModelV4({ doGenerate: text({ note: "ok" }) });
  const req = { scope, task: "t", parts: ["x"] };

  it("refuses to store, and ignores an old entry, with non-Latin letters", async () => {
    rows.length = 0;
    await writeCache(model, req, { note: BAD });
    expect(rows).toHaveLength(0);
    rows.push({ id: "old", output: { note: BAD } });
    expect(await readCache(model, req)).toBeUndefined();
  });

  it("clearAiCache removes foreign entries only, or everything with all", async () => {
    rows.length = 0;
    rows.push({ id: "a", output: { note: BAD } }, { id: "b", output: { note: "fine" } });
    expect(await clearAiCache()).toEqual({ removed: 1, foreign: 1 });
    expect(rows.map((r) => r.id)).toEqual(["b"]);
    expect(await clearAiCache({ all: true })).toEqual({ removed: 1, foreign: 0 });
  });
});
