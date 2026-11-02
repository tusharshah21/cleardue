// The mandate: limits the freelancer sets. M1 defines the shape and defaults;
// the deterministic allow / needs_approval / deny checks land in M2.
import { z } from "zod";

export const Tone = z.enum(["friendly", "firm", "formal"]);

export const MandateSchema = z.object({
  autopilot: z.boolean(),
  minConfidence: z.number().min(0).max(1),
  maxInstalments: z.number().int().min(1).max(12),
  minFirstPayment: z.union([
    z.object({ kind: z.literal("percent"), value: z.number().min(0).max(100) }),
    z.object({ kind: z.literal("amount"), valueMinor: z.number().int().min(0) }),
  ]),
  /** Latest acceptable final payment date, as days after the original due date. */
  maxPlanDays: z.number().int().min(0),
  toneCeiling: Tone,
  neverAutoContact: z.boolean(),
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }),
});

export type Mandate = z.infer<typeof MandateSchema>;

export const DEFAULT_MANDATE: Mandate = {
  autopilot: false,
  minConfidence: 0.85,
  maxInstalments: 3,
  minFirstPayment: { kind: "percent", value: 30 },
  maxPlanDays: 60,
  toneCeiling: "firm",
  neverAutoContact: false,
  quietHours: { start: 20, end: 8 },
};

/** Client overrides win over the freelancer default, field by field. */
export function effectiveMandate(base: unknown, override: unknown): Mandate {
  const parsedBase = MandateSchema.parse(base ?? DEFAULT_MANDATE);
  return MandateSchema.parse({ ...parsedBase, ...MandateSchema.partial().parse(override ?? {}) });
}
