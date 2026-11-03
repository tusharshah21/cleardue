// The three demo stories (Acme, Brightside, Koala), shared by `npm run seed`, the Reset demo button and the daily reset.
// A reset keeps the demo freelancer row, so signed-in judges stay signed in, and replaces everything under it.
import { DEFAULT_MANDATE } from "@/agent/mandate";
import { isMockMode } from "@/paypal/client";
import { cancelInvoice, deleteDraftInvoice, type LineItem } from "@/paypal/invoices";
import { createHash } from "node:crypto";
import { db } from "./db";
import { createAndSendInvoice, lineTotal, newPayToken } from "./invoicing";

const day = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * day);
const clientEmail = (slug: string) => process.env.SEED_CLIENT_EMAIL || `${slug}@example.com`;
/** Reset through PayPal when there is one to talk to: the mock, or sandbox credentials. */
export const resetViaPayPal = () => isMockMode() || !!process.env.PAYPAL_CLIENT_ID;
export const demoEmail = () => (process.env.DEMO_EMAIL || "demo@cleardue.app").toLowerCase();

interface Story {
  slug: string;
  client: { name: string; country: string; currency: string; timezone: string; approverEmail?: string; mandate?: object };
  project: { name: string; scope: string };
  items: LineItem[];
  issuedDaysAgo: number;
  dueInDays: number;
  thread: { direction: "INBOUND" | "OUTBOUND"; body: string; daysAgo: number }[];
}

export const stories: Story[] = [
  {
    slug: "acme",
    client: {
      name: "Acme Labs",
      country: "US",
      currency: "USD",
      timezone: "America/New_York",
      approverEmail: process.env.SEED_AP_EMAIL || "ap@acmelabs.example",
      mandate: { autopilot: true }, // the agent acts through PayPal with no click (demo 0:25)
    },
    project: {
      name: "Analytics dashboard redesign",
      scope: `Acme Labs: Analytics dashboard redesign. Statement of work.
1. Discovery: one 90-minute workshop with the product team and a written summary of findings.
2. UI design: up to 8 screens for the analytics dashboard, desktop and tablet layouts.
3. Revisions: two rounds of revisions per screen. Further rounds are billed at USD 45/hour.
4. Handoff: Figma file with reusable components and a one-page style guide.
5. Out of scope: front-end development, copywriting, mobile app screens.
6. Payment: invoiced on handoff, Net 30, paid through PayPal.`,
    },
    items: [
      { name: "UI design: 8 dashboard screens", quantity: 1, unitAmountMinor: 160000, unit: "AMOUNT" },
      { name: "Component library and style guide", quantity: 1, unitAmountMinor: 80000, unit: "AMOUNT" },
    ],
    issuedDaysAgo: 39,
    dueInDays: -9,
    thread: [
      { direction: "OUTBOUND", daysAgo: 3, body: "Hi Dana, just a quick note that invoice for the dashboard redesign was due last week. Here's the PayPal link again in case it got buried. Thanks!" },
      { direction: "INBOUND", daysAgo: 2, body: "Sorry, waiting on finance sign-off, should clear next week." },
    ],
  },
  {
    slug: "brightside",
    client: {
      name: "Brightside Studio",
      country: "GB",
      currency: "GBP",
      timezone: "Europe/London",
      mandate: { toneCeiling: "friendly", autopilot: false }, // plan acceptance waits for approval
    },
    project: {
      name: "Studio website build",
      scope: `Brightside Studio: Website build. Proposal accepted 14 Sept.
1. Build: 6-page marketing site in Webflow from the approved Figma designs.
2. CMS: blog and case-study collections set up, with a 30-minute editor walkthrough.
3. Launch: domain connection, redirects from the old site, basic on-page SEO.
4. Support: 14 days of bug fixes after launch.
5. Out of scope: new design work, copywriting, paid plugins.
6. Payment: on launch, due in 30 days, through PayPal.`,
    },
    items: [
      { name: "Webflow build: 6 pages", quantity: 1, unitAmountMinor: 150000, unit: "AMOUNT" },
      { name: "CMS setup and walkthrough", quantity: 1, unitAmountMinor: 30000, unit: "AMOUNT" },
    ],
    issuedDaysAgo: 35,
    dueInDays: -5,
    thread: [
      { direction: "OUTBOUND", daysAgo: 2, body: "Hi Sam, hope launch week went well! Gentle reminder that the website invoice is now a few days past due. The PayPal link is below." },
      { direction: "INBOUND", daysAgo: 1, body: "Cash is tight this month, can we split it?" },
    ],
  },
  {
    slug: "koala",
    client: { name: "Koala Digital", country: "AU", currency: "AUD", timezone: "Australia/Sydney", mandate: { autopilot: true } }, // plan acceptance runs at once
    project: {
      name: "Marketing site front end",
      scope: `Koala Digital: Marketing site front end. Scope of work.
1. Front-end development: build the marketing site in Next.js from supplied designs, billed hourly at AUD 65/hour, estimate 40 hours.
2. Responsive QA: testing on the latest two versions of Chrome, Safari, Firefox and Edge, on iOS and Android phones and tablets, at four breakpoints (360, 768, 1024 and 1440 px), including fixes for any layout bugs found. Excludes Internet Explorer, legacy browsers and performance optimisation.
3. Deployment: one production deploy to Koala's Vercel account.
4. Out of scope: backend, CMS integration, analytics setup.
5. Payment: due 14 days from invoice, through PayPal.`,
    },
    items: [
      { name: "Front-end development", quantity: 40, unitAmountMinor: 6500, unit: "HOURS" },
      { name: "Responsive QA", description: "Cross-browser and cross-device testing with fixes", quantity: 1, unitAmountMinor: 60000, unit: "AMOUNT" },
    ],
    issuedDaysAgo: 10,
    dueInDays: 4,
    thread: [],
  },
];

/** Identifies the story inputs (clients, scopes, items, threads). The AI response cache is valid only for the stories it was made under. */
export const seedFingerprint = () => createHash("sha256").update(JSON.stringify(stories)).digest("hex").slice(0, 16);

const OPEN = ["SENT", "UNPAID", "SCHEDULED"];

/** Cancels (or deletes, for drafts) the demo freelancer's open PayPal invoices, so PayPal matches the fresh DB. A failure
 * is logged and skipped: the invoice may already be closed in PayPal, or gone with the mock file after a deploy. */
async function closePayPalInvoices(freelancerId: string) {
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId }, paypalInvoiceId: { not: null }, status: { in: [...OPEN, "DRAFT"] } },
  });
  for (const i of invoices) {
    try {
      if (i.status === "DRAFT") await deleteDraftInvoice(i.paypalInvoiceId!);
      else await cancelInvoice(i.paypalInvoiceId!, { sendToRecipient: false, note: "Replaced by a demo reset." });
    } catch (e) {
      console.warn(`Demo reset: could not close PayPal invoice ${i.paypalInvoiceId}:`, e instanceof Error ? e.message : e);
    }
  }
  return invoices.length;
}

/** Replaces the demo freelancer's data with the three stories. Only the demo freelancer is touched. */
export async function resetDemo({ withPayPal }: { withPayPal: boolean }) {
  const profile = { name: "Aarav Mehta", businessName: "Aarav Mehta Design", country: "IN", currency: "USD", timezone: "Asia/Kolkata", mandate: DEFAULT_MANDATE };
  const existing = await db.freelancer.findUnique({ where: { email: demoEmail() } });
  const closed = existing && withPayPal ? await closePayPalInvoices(existing.id) : 0;
  // ponytail: no lock, two resets at the same moment can interleave; add a pg advisory lock if that ever shows up.
  if (existing) await db.client.deleteMany({ where: { freelancerId: existing.id } });
  const freelancer = existing
    ? await db.freelancer.update({ where: { id: existing.id }, data: profile })
    : await db.freelancer.create({ data: { email: demoEmail(), ...profile } });

  const seeded: string[] = [];
  for (const s of stories) {
    const client = await db.client.create({ data: { freelancerId: freelancer.id, email: clientEmail(s.slug), ...s.client } });
    const project = await db.project.create({ data: { clientId: client.id, ...s.project } });
    const invoiceDate = daysFromNow(-s.issuedDaysAgo);
    const dueDate = daysFromNow(s.dueInDays);

    const invoice = withPayPal
      ? await createAndSendInvoice({ freelancer, client, projectId: project.id, items: s.items, invoiceDate, dueDate })
      : await db.invoice.create({
          data: {
            clientId: client.id,
            projectId: project.id,
            status: "SENT",
            currency: client.currency,
            totalMinor: lineTotal(s.items),
            issueDate: invoiceDate,
            dueDate,
            items: s.items as object[],
            payToken: newPayToken(),
          },
        });

    for (const m of s.thread) {
      await db.message.create({
        data: {
          clientId: client.id,
          invoiceId: invoice.id,
          direction: m.direction,
          channel: m.direction === "INBOUND" ? "paste" : "outbox",
          body: m.body,
          status: m.direction === "OUTBOUND" ? "sent" : null,
          sentAt: daysFromNow(-m.daysAgo),
        },
      });
    }
    seeded.push(`${client.name}: invoice ${invoice.paypalInvoiceId ?? "(local only)"} ${invoice.status}`);
  }
  // Cached AI results stay across a reset while the stories are unchanged; ones made under other stories are stale.
  await db.aiCache.deleteMany({ where: { freelancerId: freelancer.id, NOT: { seed: seedFingerprint() } } });
  return { freelancerId: freelancer.id, closed, seeded };
}

/** When the demo was last reset: the oldest client is created by the reset itself. Null if there is no demo data. */
export async function lastDemoReset() {
  const oldest = await db.client.findFirst({ where: { freelancer: { email: demoEmail() } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  return oldest?.createdAt ?? null;
}

/** The daily reset runs at 03:00 UTC, a quiet time for judges in the US, Europe and India. */
const DAILY_RESET_HOUR_UTC = 3;

/** The most recent 03:00 UTC at or before `now`. */
function lastScheduledReset(now: Date) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_RESET_HOUR_UTC));
  return at > now ? new Date(at.getTime() - day) : at;
}

/** The next 03:00 UTC after `now`, shown on Start here. */
export const nextScheduledReset = (now = new Date()) => new Date(lastScheduledReset(now).getTime() + day);

/** For the cron (every few minutes): with DEMO_DAILY_RESET=true, resets the demo once the 03:00 UTC slot has passed
 * and the demo hasn't been reset since (or there is no demo data). */
export async function dailyDemoReset(now = new Date()) {
  if (process.env.DEMO_DAILY_RESET !== "true") return false;
  const last = await lastDemoReset();
  if (last && last >= lastScheduledReset(now)) return false;
  await resetDemo({ withPayPal: resetViaPayPal() });
  return true;
}

const MANUAL_RESET_GAP = 5 * 60_000;

/** Reset demo is limited to once per 5 minutes across all judges: minutes left to wait, or 0. */
export async function manualResetWait(now = new Date()) {
  const last = await lastDemoReset();
  const left = last ? MANUAL_RESET_GAP - (now.getTime() - last.getTime()) : 0;
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}
