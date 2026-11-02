// PayPal Agent Toolkit adapter. The toolkit ships AI SDK v4 tools (zod v3 schemas); ClearDue runs AI SDK v7.
// We lift each tool's description, schema and execute, and never expose execute to the model directly:
// src/agent/tools.ts puts the mandate check in front of it.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config, PayPalError } from "@/paypal/client";

export const TOOLKIT_TOOLS = ["get_invoice", "send_invoice_reminder", "cancel_sent_invoice", "record_payment_for_invoice"] as const;
export type ToolkitToolName = (typeof TOOLKIT_TOOLS)[number];

interface ZodV3Like {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
}
interface V4Tool {
  description?: string;
  parameters: ZodV3Like;
  execute: (args: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
}

export interface ToolkitTool {
  description: string;
  jsonSchema: JSONSchema7;
  validate: (value: unknown) => { success: true; value: Record<string, unknown> } | { success: false; error: Error };
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

let cached: { key: string; tools: Record<ToolkitToolName, ToolkitTool> } | null = null;

export function toolkitTools(): Record<ToolkitToolName, ToolkitTool> {
  // Schemas load without credentials so the agent always sees the same tools; run() requires sandbox config.
  const key = `${process.env.PAYPAL_CLIENT_ID ?? ""}:${process.env.PAYPAL_CLIENT_SECRET ?? ""}`;
  if (cached?.key === key) return cached.tools;
  const toolkit = new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID || "unset",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "unset",
    configuration: {
      actions: { invoices: { get: true, sendReminder: true, cancel: true, recordPayment: true } },
      context: { sandbox: true },
    },
  });
  const raw = toolkit.getTools() as unknown as Record<string, V4Tool>;
  const tools = Object.fromEntries(
    TOOLKIT_TOOLS.map((name) => {
      const t = raw[name];
      if (!t) throw new Error(`Agent Toolkit has no ${name} tool`);
      const tool: ToolkitTool = {
        description: t.description ?? name,
        jsonSchema: zodToJsonSchema(t.parameters as never, { target: "jsonSchema7", $refStrategy: "none" }) as JSONSchema7,
        validate: (value) => {
          const r = t.parameters.safeParse(value);
          return r.success ? { success: true, value: r.data as Record<string, unknown> } : { success: false, error: new Error(r.error.message) };
        },
        run: async (args) => {
          config(); // sandbox host + credentials, or a readable error
          return parseToolkitResult(name, await t.execute(args, { toolCallId: "cleardue", messages: [] }));
        },
      };
      return [name, tool];
    }),
  ) as Record<ToolkitToolName, ToolkitTool>;
  cached = { key, tools };
  return tools;
}

/** The toolkit returns JSON strings and reports failures as `{ error }` instead of throwing. Make failures throw. */
export function parseToolkitResult(name: string, raw: unknown): unknown {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = raw ? JSON.parse(raw) : {};
    } catch {
      return raw;
    }
  }
  if (value && typeof value === "object") {
    const v = value as { error?: { message?: string } | string; name?: string; message?: string; debug_id?: string };
    if (v.error) {
      const message = typeof v.error === "string" ? v.error : (v.error.message ?? "unknown error");
      throw new PayPalError(`PayPal ${name} failed: ${message}`, 502);
    }
    if (v.debug_id && v.name && v.message) throw new PayPalError(`PayPal ${name} failed: ${v.name}: ${v.message}`, 502, v.debug_id);
  }
  return value;
}
