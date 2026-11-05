// The agent's tools. Every tool's execute() runs the mandate check first:
//   allow           -> executes now (PayPal via the Agent Toolkit, or a ClearDue action)
//   needs_approval  -> recorded and queued for the freelancer
//   deny            -> recorded with reasons, never executed
// The model sees the outcome as the tool result.
import { jsonSchema, tool, type ToolSet } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { z } from "zod";
import { toMinor } from "@/lib/money";
import { checkAction, Tone, type AgentAction, type MandateContext, type MandateResult } from "./mandate";
import { TOOLKIT_TOOLS, toolkitTools, type ToolkitToolName } from "./toolkit";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const decimal = z.string().regex(/^\d+(\.\d{1,2})?$/, "decimal amount like 900.00");
const dateOf = (s: string) => new Date(`${s}T00:00:00Z`);

export const LOCAL_TOOLS = {
  send_message: {
    description:
      "Queue an email to the client (or their approver) in the freelancer's voice. Use for friendly nudges with the pay link, replies, asking for the right contact, or answering a payment claim.",
    schema: z.object({
      to: z.enum(["client", "approver"]),
      tone: Tone,
      subject: z.string().min(1).max(150),
      body: z.string().min(1).max(2000),
    }),
  },
  pause_reminders: {
    description: "Pause all reminders on this invoice until a date (for example while approval is pending or until a promised date plus grace).",
    schema: z.object({ until: isoDate, reason: z.string().min(1).max(300) }),
  },
  offer_payment_plan: {
    description:
      "Offer the client a payment plan: instalment amounts (decimal strings in the invoice currency) that sum exactly to the outstanding amount, with strictly increasing due dates, plus the message that presents it.",
    schema: z.object({
      instalments: z.array(z.object({ amount: decimal, due_date: isoDate })).min(2).max(12),
      tone: Tone,
      message: z.string().min(1).max(2000),
    }),
  },
  escalate_dispute: {
    description: "Stop all automation on this invoice and hand the dispute to the freelancer with a neutral summary of what the client objects to.",
    schema: z.object({ summary: z.string().min(1).max(1000) }),
  },
} as const;

export type LocalToolName = keyof typeof LOCAL_TOOLS;
export type AgentToolName = LocalToolName | ToolkitToolName;
export const AGENT_TOOL_NAMES: AgentToolName[] = [...(Object.keys(LOCAL_TOOLS) as LocalToolName[]), ...TOOLKIT_TOOLS];

export interface GateContext {
  mandate: MandateContext;
  currency: string;
  approverEmail: string | null;
}

export interface Proposal {
  toolName: string;
  input: Record<string, unknown>;
  action: AgentAction | null;
  result: MandateResult;
  draft: string | null;
}

export interface GateHooks {
  /** Persist the proposal (any verdict); returns its id. */
  record(p: Proposal): Promise<string>;
  /** Run an allowed proposal and persist the outcome. */
  execute(proposalId: string, p: Proposal): Promise<unknown>;
}

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Plan instalments from tool input (decimal amounts, YYYY-MM-DD dates) in minor units. */
export const planInstalments = (instalments: unknown, currency: string) =>
  LOCAL_TOOLS.offer_payment_plan.schema.shape.instalments.parse(instalments).map((p) => ({ amountMinor: toMinor(p.amount, currency), dueDate: dateOf(p.due_date) }));

/** Translates a tool call into the action the mandate understands. Throws on input the mandate can't judge. */
export function toAction(toolName: string, input: Input, ctx: GateContext): AgentAction {
  switch (toolName) {
    case "get_invoice":
      return { type: "read_invoice", invoiceId: str(input.invoice_id) };
    case "send_invoice_reminder":
      return {
        type: "send_reminder",
        invoiceId: str(input.invoice_id),
        tone: Tone.parse(input.tone),
        note: str(input.note),
        additionalRecipients: Array.isArray(input.additional_recipients) ? input.additional_recipients.map(String) : [],
      };
    case "cancel_sent_invoice":
      return { type: "cancel_invoice", invoiceId: str(input.invoice_id) };
    case "record_payment_for_invoice": {
      const amount = input.amount as { value?: string; currency_code?: string } | undefined;
      if (!amount?.value) throw new Error("payment amount is missing");
      if (amount.currency_code && amount.currency_code !== ctx.currency) throw new Error(`payment currency must be ${ctx.currency}`);
      return { type: "record_payment", invoiceId: str(input.invoice_id), amountMinor: toMinor(amount.value, ctx.currency) };
    }
    case "send_message": {
      const i = LOCAL_TOOLS.send_message.schema.parse(input);
      if (i.to === "approver" && !ctx.approverEmail) throw new Error("no approver contact on file");
      return { type: "send_message", to: i.to, tone: i.tone, body: i.body };
    }
    case "pause_reminders":
      return { type: "pause_reminders", until: dateOf(LOCAL_TOOLS.pause_reminders.schema.parse(input).until) };
    case "offer_payment_plan":
      return { type: "offer_plan", instalments: planInstalments(input.instalments, ctx.currency), message: LOCAL_TOOLS.offer_payment_plan.schema.parse(input).message };
    // Not a model tool: a plan the client accepted on the pay page, waiting for the freelancer (src/plans/accept.ts).
    case "apply_payment_plan":
      return { type: "offer_plan", instalments: planInstalments(input.instalments, ctx.currency) };
    case "escalate_dispute":
      return { type: "escalate_to_freelancer", summary: LOCAL_TOOLS.escalate_dispute.schema.parse(input).summary };
    default:
      throw new Error(`unknown tool ${toolName}`);
  }
}

/** The human-editable text of a proposal, shown and edited in the approval queue. */
export function draftOf(toolName: string, input: Input): string | null {
  const text = { send_message: input.body, send_invoice_reminder: input.note, offer_payment_plan: input.message, escalate_dispute: input.summary }[toolName];
  return typeof text === "string" ? text : null;
}

export type ToolOutcome =
  | { status: "done"; result: unknown }
  | { status: "queued_for_freelancer_approval"; reasons: string[] }
  | { status: "denied"; reasons: string[] }
  | { status: "failed"; error: string };

export async function gate(toolName: string, input: Input, ctx: GateContext, hooks: GateHooks): Promise<ToolOutcome> {
  let action: AgentAction | null = null;
  let result: MandateResult;
  try {
    action = toAction(toolName, input, ctx);
    result = checkAction(action, ctx.mandate);
  } catch (e) {
    result = { verdict: "deny", reasons: [`invalid ${toolName} request: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const proposal: Proposal = { toolName, input, action, result, draft: draftOf(toolName, input) };
  const id = await hooks.record(proposal);
  if (result.verdict === "deny") return { status: "denied", reasons: result.reasons };
  if (result.verdict === "needs_approval") return { status: "queued_for_freelancer_approval", reasons: result.reasons };
  try {
    return { status: "done", result: await hooks.execute(id, proposal) };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Adds ClearDue's required `tone` field to the toolkit's reminder schema so the tone ceiling can be enforced. */
function withTone(schema: JSONSchema7): JSONSchema7 {
  return {
    ...schema,
    properties: { ...schema.properties, tone: { type: "string", enum: [...Tone.options], description: "Tone of the reminder note" } },
    required: [...(schema.required ?? []), "tone"],
  };
}

export function buildAgentTools(ctx: GateContext, hooks: GateHooks): ToolSet {
  const tools: ToolSet = {};
  for (const [name, def] of Object.entries(LOCAL_TOOLS)) {
    tools[name] = tool({
      description: def.description,
      inputSchema: def.schema as z.ZodType<Input>,
      execute: (input: Input) => gate(name, input, ctx, hooks),
    });
  }
  for (const [name, t] of Object.entries(toolkitTools())) {
    const toned = name === "send_invoice_reminder";
    tools[name] = tool({
      description: t.description,
      inputSchema: jsonSchema<Input>(toned ? withTone(t.jsonSchema) : t.jsonSchema, {
        validate: (value) => {
          if (!toned) return t.validate(value);
          const { tone, ...rest } = (value ?? {}) as Input;
          const parsedTone = Tone.safeParse(tone);
          if (!parsedTone.success) return { success: false, error: new Error("tone must be friendly, firm or formal") };
          const r = t.validate(rest);
          return r.success ? { success: true, value: { ...r.value, tone: parsedTone.data } } : r;
        },
      }),
      execute: (input: Input) => gate(name, input, ctx, hooks),
    });
  }
  return tools;
}
