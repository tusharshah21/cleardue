// Demo seed: one Indian freelancer, three overseas clients that tell the ClearDue story.
//   npm run seed           local data only (no PayPal calls)
//   npm run seed:paypal    also creates and sends real sandbox invoices (needs PAYPAL_* and SEED_CLIENT_EMAIL)
import "dotenv/config";
import { DEFAULT_MANDATE } from "../src/agent/mandate";
import { db } from "../src/lib/db";
import { createAndSendInvoice, lineTotal, newPayToken } from "../src/lib/invoicing";
import { isMockMode } from "../src/paypal/client";
import type { LineItem } from "../src/paypal/invoices";
import { resetMock } from "../src/paypal/mock";

// In PAYPAL_MODE=mock the seed always goes through (mock) PayPal, so every flow works locally.
const withPayPal = process.argv.includes("--paypal") || isMockMode();
const day = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * day);
const clientEmail = (slug: string) => process.env.SEED_CLIENT_EMAIL || `${slug}@example.com`;

const demoEmail = (process.env.DEMO_EMAIL || "demo@cleardue.app").toLowerCase();

interface Story {
  slug: string;
  client: { name: string; country: string; currency: string; timezone: string; approverEmail?: string; mandate?: object };
  project: { name: string; scope: string };
  items: LineItem[];
  issuedDaysAgo: number;
  dueInDays: number;
  thread: { direction: "INBOUND" | "OUTBOUND"; body: string; daysAgo: number }[];
}

const stories: Story[] = [
  {
    slug: "acme",
    client: {
      name: "Acme Labs",
      country: "US",
      currency: "USD",
      timezone: "America/New_York",
      approverEmail: process.env.SEED_AP_EMAIL || "ap@acmelabs.example",
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

async function main() {
  // Fresh start: everything hangs off the freelancer and cascades.
  await db.freelancer.deleteMany({});
  if (isMockMode()) resetMock();
  const freelancer = await db.freelancer.create({
    data: {
      email: demoEmail,
      name: "Aarav Mehta",
      businessName: "Aarav Mehta Design",
      country: "IN",
      currency: "USD",
      timezone: "Asia/Kolkata",
      mandate: DEFAULT_MANDATE,
    },
  });

  for (const s of stories) {
    const client = await db.client.create({
      data: { freelancerId: freelancer.id, email: clientEmail(s.slug), ...s.client },
    });
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
    console.log(`Seeded ${client.name}: invoice ${invoice.paypalInvoiceId ?? "(local only)"} ${invoice.status}`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
