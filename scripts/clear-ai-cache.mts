// npm run cache:clear -- [--all] [--url https://cleardue-6laj.onrender.com]
// Clears the demo's AI response cache on a running app through its protected maintenance route (CRON_SECRET from the
// environment or .env). Without --all only entries containing non-Latin letters are removed.
import fs from "node:fs";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const base = (urlIdx >= 0 ? args[urlIdx + 1] : process.env.APP_URL ?? "https://cleardue-6laj.onrender.com").replace(/\/$/, "");
let secret = process.env.CRON_SECRET;
if (!secret && fs.existsSync(".env")) secret = fs.readFileSync(".env", "utf8").match(/^CRON_SECRET=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!secret) throw new Error("CRON_SECRET is not set");
const res = await fetch(`${base}/api/maintenance/clear-ai-cache`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  body: JSON.stringify({ all: args.includes("--all") }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
