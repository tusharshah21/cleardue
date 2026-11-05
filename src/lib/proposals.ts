// Plain-language labels for agent proposals, shared by the approval queue and the invoice page.
type Params = Record<string, unknown>;

export const REASON_LABELS: Record<string, string> = {
  no_response: "No reply yet",
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
    case "apply_payment_plan": {
      const parts = Array.isArray(p.instalments) ? (p.instalments as { amount: string; due_date: string }[]) : [];
      return { title: `Client accepted a ${parts.length}-part plan: set it up on PayPal`, detail: parts.map((i) => `${i.amount} on ${i.due_date}`).join(" · ") };
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
      return { title: "Agent action" };
  }
}

/** The action as plain English for the timeline, in two forms: "sending a PayPal reminder to…" and "sent a PayPal
 * reminder to…". Never shows tool names. */
export function actionText(type: string, p: Params, approverEmail: string | null): { doing: string; done: string } {
  const both = (doing: string, done: string) => ({ doing, done });
  switch (type) {
    case "send_invoice_reminder": {
      const extra = Array.isArray(p.additional_recipients) ? p.additional_recipients.map(String) : [];
      const others = extra.map((e) => (e === approverEmail ? "their AP contact" : e));
      const to = others.length ? `the client and ${others.join(" and ")}` : "the client";
      return both(`sending a PayPal reminder to ${to}`, `sent a PayPal reminder to ${to}`);
    }
    case "send_message": {
      const to = p.to === "approver" ? "the client's AP contact" : "the client";
      return both(`emailing ${to}`, `queued an email to ${to} in your Outbox`);
    }
    case "pause_reminders":
      return both(`pausing reminders until ${p.until}`, `paused reminders until ${p.until}`);
    case "offer_payment_plan":
    case "apply_payment_plan": {
      const n = Array.isArray(p.instalments) ? p.instalments.length : 0;
      return type === "offer_payment_plan"
        ? both(`offering a ${n}-part payment plan`, `offered a ${n}-part payment plan`)
        : both(`setting up the client's ${n}-part payment plan on PayPal`, `set up the client's ${n}-part payment plan on PayPal`);
    }
    case "escalate_dispute":
      return both("escalating the dispute to you", "escalated the dispute to you");
    case "get_invoice":
      return both("checking the invoice on PayPal", "checked the invoice on PayPal");
    case "cancel_sent_invoice":
      return both("cancelling the PayPal invoice", "cancelled the PayPal invoice");
    case "record_payment_for_invoice":
      return both("recording a payment on PayPal", "recorded a payment on PayPal");
    case "manual_review":
      return both("a review by you", "flagged this for your review");
    default:
      return both("an action", "took an action");
  }
}

const VERDICT_TEXT: Record<string, string> = { allow: "allowed by your mandate", needs_approval: "needs your approval", deny: "blocked by your mandate" };
export const verdictText = (verdict: string) => VERDICT_TEXT[verdict] ?? verdict;

export const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting for you",
  auto_executed: "Done by autopilot",
  executed: "Approved and done",
  rejected: "Rejected",
  superseded: "Superseded",
  denied: "Blocked by mandate",
  failed: "Failed",
};
