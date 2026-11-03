# Devpost: Built with / Tools

Paste into the "Built With" and tools fields.

**Built with:** Next.js, TypeScript, Postgres (Neon), Prisma, PayPal Invoicing API (sandbox) and PayPal Agent Toolkit, Vercel AI SDK, Google Gemini (`gemini-3.5-flash-lite`), AG Grid, Render.

**AI provider and model:** Google Gemini `gemini-3.5-flash-lite`, called through the Vercel AI SDK with the Gemini API's free tier from Google AI Studio. The provider is swappable by configuration (`AI_PROVIDER`): Anthropic Claude is supported too, and the model name always comes from `AI_MODEL`.

**Data note:** on Google's free tier, content sent to the model may be used by Google to improve its products; the demo only handles made-up data, and the hosted demo's Gemini project is moved to a paid tier before judging. Production uses a paid tier (or Claude).

**How the AI is kept safe:** the model proposes, deterministic TypeScript validates. Every action goes through a mandate gate that allows it, holds it for the freelancer's approval, or refuses it. Model output is schema-validated, quotes must appear verbatim in the sources, and a misread reply still has to clear the mandate (low-confidence actions wait for approval). Rate-limited or overloaded calls are retried once and then fall back to a recorded response (labelled "Replayed response") or to a human, and the demo account reuses its first live result for identical requests (labelled "Cached result from an earlier live run") to stay within quota.
