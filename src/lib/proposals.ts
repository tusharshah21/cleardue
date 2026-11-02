// Plain-language labels for agent proposals, shared by the approval queue and the invoice page.
type Params = Record<string, unknown>;

export const REASON_LABELS: Record<string, string> = {
  forgot: "Forgot",
  awaiting_approval: "Awaiting approval",
  cash_constraint: "Cash constraint",
  dispute: "Dispute",
  wrong_contact: "Wrong contact",
  promised_date: "Promised a date",
  claims_paid: "Says it's paid",
  other: "Unclear",
};

export function describeProposal(type: string, p: Params): { title: string; detail?: string } {
  switch (type) {
    case "send_message":
      return { title: p.to === "approver" ? "Email the approver" : "Email the client", detail: `${p.tone} tone · ${p.subject ?? ""}` };
    case "send_invoice_reminder": {
      const extra = Array.isArray(p.additional_recipients) && p.additional_recipients.length ? ` + ${p.additional_recipients.join(", ")}` : "";
      return { title: "Send PayPal reminder", detail: `to the client${extra} · ${p.tone} tone` };
    }
    case "pause_reminders":
      return { title: `Pause reminders until ${p.until}`, detail: String(p.reason ?? "") };
    case "offer_payment_plan": {
      const parts = Array.isArray(p.instalments) ? (p.instalments as { amount: string; due_date: string }[]) : [];
      return { title: `Offer a ${parts.length}-part payment plan`, detail: parts.map((i) => `${i.amount} on ${i.due_date}`).join(" · ") };
    }
    case "escalate_dispute":
      return { title: "Stop automation and escalate the dispute to you" };
    case "get_invoice":
      return { title: "Check the invoice status on PayPal" };
    case "cancel_sent_invoice":
      return { title: "Cancel the PayPal invoice", detail: p.send_to_recipient ? "client is notified" : "silently" };
    case "record_payment_for_invoice": {
      const amount = p.amount as { value?: string; currency_code?: string } | undefined;
      return { title: "Record a payment on PayPal", detail: amount ? `${amount.currency_code} ${amount.value}` : undefined };
    }
    case "manual_review":
      return { title: "Needs your review" };
    default:
      return { title: type };
  }
}

export const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting for you",
  auto_executed: "Done by autopilot",
  executed: "Approved and done",
  rejected: "Rejected",
  denied: "Blocked by mandate",
  failed: "Failed",
};
