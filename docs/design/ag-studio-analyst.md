# Estimate: "Collections analyst" dashboard on AG Studio

Status: estimate only. Build after the PayPal sandbox works, if approved.

## What the prize asks for

The AG Grid award on the [hackathon page](https://paypalaihackathon.devpost.com/details/aggrid) judges "both what your dashboard looks like and how you build it". It asks for custom widgets, theming and layout tools (not plain AG Grid or AG Charts), and the Studio Agent Framework: "a custom agent talking to Studio's built-in agents, or a swapped-in harness". One of its sample ideas is a gentle-reminder agent over unpaid invoices with a "who still owes what" widget, which is close to ClearDue already. Our current AG Grid Community table doesn't qualify.

## What the boilerplate gives us

[paypaldev/hackathon-paypal-ag-grid-boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) is a Next.js + TypeScript app, the same shape as ClearDue:

- It fetches PayPal REST data (products, plans, invoices, transactions, balances) with plain `fetch`.
- `/dashboard` is an `AgStudio` report over joined tables. Its data sources, relationships, theme and default report live in `app/dashboard/studio`.
- The license key goes in `AG_STUDIO`. The free 45-day trial covers the hackathon.
- The AI assistant uses an OpenAI adapter in the browser that posts to a server proxy (`/api/ai/responses`), and the README warns it has no auth or rate limiting.

We'd copy patterns from it (provider setup, data sources, theme), not the app. Our data comes from our own database, which already has the cases, reasons and mandate decisions the dashboard needs.

## Proposed design

A new signed-in page, `/analyst`, rendering `AgStudio` (from `ag-studio-react`) with:

- **Data sources**, built server-side from Prisma: invoices with outstanding amounts and aging, cases with the reason and confidence, proposals with the mandate verdict and status, plan groups, and clients.
- **Custom widgets** (`AgWidgetDefinition` + `createWidgets`; about 20 lines of definition plus a React component each):
  1. "Who still owes what" scoreboard: one row per client, coloured by diagnosed reason, with days overdue and the next action.
  2. Mandate decisions: allowed, approved, waiting and denied counts, with the reasons. This shows the "LLM proposes, TypeScript decides" rule as data.
  3. Plan tracker: instalments paid or due per plan, with the split-invoice strategy marked.
- **Theming**: Studio grid and chart themes mapped to our shadcn colour tokens, so the dashboard looks like the rest of ClearDue.
- **Custom agent, the "collections analyst"**: a Client Tool Runner whose `run` calls our server, `POST /api/analyst/agent`.
  - The server runs Claude through the AI SDK (model from `AI_MODEL`), like every other ClearDue AI task. The API key never reaches the browser, and we avoid the boilerplate's unauthenticated proxy.
  - Read-only tools answer questions over receivables ("who is most overdue?", "how much is stuck in approval?").
  - One write tool, `propose_action`, goes through `gate()` and our mandate, exactly like the diagnosis agent. **My recommendation:** analyst proposals always land on Approvals, never auto-run, since nobody diagnosed the case. Say if you'd rather apply the normal autopilot rules.
  - For building or changing widgets, the analyst hands off to Studio's built-in agents with `tools.delegateTo(...)`. That's the "custom agent talking to Studio's built-in agents" part.

## Effort

| Piece | Estimate |
| --- | --- |
| Spike: install AG Studio with the trial key, render one source from our DB, check it works with Next 16 / React 19 and our Tailwind setup | 0.5 day |
| Data sources and the default report layout | 0.5 day |
| Three custom widgets and theming | 1 day |
| Analyst agent: server route with tools and the gate, Client Tool Runner streaming, delegation to built-in agents | 1 to 1.5 days |
| Tests (gate on `propose_action`, read tools), README section, demo beat | 0.5 day |
| **Total** | **3.5 to 4 days** |

## Risks and unknowns

- **Docs gaps.** The agent docs show the runners (`directLlmRunner`, `clientToolRunner`, custom) and `createAiHarness` with `primary` and delegates. But they don't show how to write a custom tool or the stream format a Client Tool Runner must return. The spike has to settle this first. If it's hard, the fallback is a Direct LLM Runner with an adapter that calls our server, which is the boilerplate's pattern.
- **Schedule.** Code freeze is Nov 11. Sandbox verification, Render Workflows (1 to 1.5 days) and this (3.5 to 4 days) add up to most of the remaining time. If both prizes are wanted, I'd do Workflows first (smaller, and it strengthens the core agent story), then AG Studio.
- **License.** AG Studio is commercial. The trial key stays in env (`AG_STUDIO`), never in the repo, and the MIT license covers only our code. The hosted demo stops rendering the dashboard after the trial ends (45 days, which covers judging).
- **Bundle size.** Load AG Studio only on `/analyst`, so the pay page and the rest of the app don't pay for it.
- **Demo time.** The video is capped at 3 minutes and already runs 2:40. A 15 to 20 second analyst beat means trimming another scene.
