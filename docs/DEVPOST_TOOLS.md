# Devpost: Built with / Tools

Paste into the "Built With" and tools fields.

**Built with:** Next.js, TypeScript, Postgres (Neon), Prisma, PayPal Invoicing API (sandbox) and PayPal Agent Toolkit, Vercel AI SDK, OpenAI (`gpt-5.4-mini`), Google Gemini (`gemini-3.5-flash-lite`), AG Studio (AG Grid), Render.

**AI providers and models:** the primary is OpenAI `gpt-5.4-mini`, called through the Vercel AI SDK. Google Gemini `gemini-3.5-flash-lite` is the fallback: if OpenAI is rate limited, out of quota, down or rejects the key, the same request goes once to Gemini, and only after that to a recorded response (labelled "Replayed response") or to a human. Every answer says which provider and model actually produced it. The providers and models are configuration (`AI_PROVIDER`, `AI_MODEL`, `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL`), and Anthropic Claude is supported too.

**Why this primary:** on 30 labelled client replies and 15 fixed task scenarios (scope checks, pay-page questions, tool-calling proposals through the mandate gate, and the analyst agent), `gpt-5.4-mini` and Gemini both scored 100% on the replies, and `gpt-5.4-mini` was about twice as fast (2.4 s against 4.3 s per call) and held up when the Gemini API was slow. A smaller OpenAI model was cheaper but misjudged scope checks, so it was not used. The numbers are in the README.

**Data note:** the demo only handles made-up data. OpenAI's API does not use API content for training by default; on Google's free tier, content may be used by Google to improve its products, so the Gemini project is moved to a paid tier before judging. Production uses paid tiers.

**How the AI is kept safe:** the model proposes, deterministic TypeScript validates. Every action goes through a mandate gate that allows it, holds it for the freelancer's approval, or refuses it. Model output is schema-validated, quotes must appear verbatim in the sources, and a misread reply still has to clear the mandate (low-confidence actions wait for approval). The demo account reuses its first live result for identical requests (labelled "Cached result from an earlier live run") to stay within quota.
