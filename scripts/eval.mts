// Reply-classification eval: runs each set in evals/ (synthetic, synthetic-india, real) through the live model and reports per-reason accuracy,
// set by set. Needs AI_MODEL and the key for AI_PROVIDER (google, openai or anthropic); DEMO_MODE is
// ignored, and so is any failover: it measures the primary provider alone. Calls are paced (EVAL_DELAY_MS, default 6000 = 10 a
// minute) to stay under the Gemini free tier's per-minute limit; use 0 for a paid tier. EVAL_OUT sets the output file.
//   npm run eval                       every set
//   npm run eval -- synthetic-india    one set (synthetic | synthetic-india | real)
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { aiProvider, keyVar, liveModel } from "../src/ai/provider";
import { retryTransient } from "../src/ai/replay";
import { classifyReply } from "../src/ai/tasks";
import { EVAL_SETS, score, type EvalCase, type EvalResult } from "../evals/score";

const modelId = process.env.AI_MODEL;
const keyName = keyVar(aiProvider());
if (!modelId || !process.env[keyName]) {
  console.error(`npm run eval needs AI_MODEL and ${keyName} in .env (it always calls the live model).`);
  process.exit(1);
}
const model = retryTransient(liveModel());
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 6000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const only = process.argv[2];
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)}%`;
const report: Record<string, unknown> = { provider: aiProvider(), model: modelId, ranAt: new Date().toISOString() };

for (const set of EVAL_SETS.filter((s) => !only || s === only)) {
  const { today, cases } = JSON.parse(readFileSync(`evals/${set}.json`, "utf8")) as { today: string; cases: EvalCase[] };
  if (!cases.length) {
    console.log(`\n== ${set}: no cases yet, skipped`);
    continue;
  }
  const results: EvalResult[] = [];
  const latencies: number[] = [];
  let failures = 0; // consecutive AI errors
  process.stdout.write(`\n== ${set} (${cases.length} replies) `);
  for (const c of cases) {
    if (results.length) await sleep(delayMs);
    const now = new Date(`${c.today ?? today}T09:00:00Z`);
    const t0 = Date.now();
    const r = await classifyReply(model, {
      clientName: c.client?.name ?? "Client",
      invoiceSummary: c.client ? `Invoice 0001, ${c.client.currency} ${c.client.amount}, ${c.client.days_overdue} days overdue` : "Invoice 0001, USD 2400.00, 13 days overdue",
      thread: [
        { from: "freelancer", at: new Date(now.getTime() - 6 * 86_400_000), body: "Hi, a friendly reminder that invoice 0001 is now overdue." },
        ...c.messages.map((body) => ({ from: "client" as const, at: now, body })),
      ],
      now,
    });
    if (!r.fallback) latencies.push(Date.now() - t0);
    failures = r.fallback ? failures + 1 : 0;
    if (failures >= 3) {
      while (results.at(-1)?.fallback) results.pop(); // the run of AI errors says nothing about the model
      console.log(`
Stopped after ${results.length} answered replies: 3 AI errors in a row (${r.error}).`);
      break;
    }
    results.push({ id: c.id, expected: c.expected, got: r.value.reason, confidence: r.value.confidence, fallback: r.fallback, promisedDate: c.promisedDate, gotDate: r.value.promisedDate });
    process.stdout.write(r.value.reason === c.expected ? "." : "x");
  }

  const s = score(results);
  console.log(`\nOverall: ${s.correct}/${s.total} (${pct(s.correct, s.total)})${s.fallbacks ? `, ${s.fallbacks} fallbacks (AI errors)` : ""}`);
  console.table(Object.fromEntries(s.perReason.map((r) => [r.reason, { correct: r.correct, n: r.n, accuracy: pct(r.correct, r.n) }])));
  const sorted = [...latencies].sort((a, b) => a - b);
  const latency = { avgMs: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)), p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0 };
  console.log(`Latency per call: avg ${latency.avgMs} ms, p95 ${latency.p95Ms} ms`);
  if (s.dates.n) console.log(`Promised dates resolved: ${s.dates.correct}/${s.dates.n}`);
  for (const m of s.misses) console.log(`  miss ${m.id}: expected ${m.expected}, got ${m.got} (${m.confidence})`);
  report[set] = { ...s, latency, results };
}

writeFileSync(process.env.EVAL_OUT ?? "evals/last-run.json", JSON.stringify(report, null, 2) + "\n");
console.log(`\nProvider: ${aiProvider()}, model: ${modelId}. Wrote ${process.env.EVAL_OUT ?? "evals/last-run.json"}`);
