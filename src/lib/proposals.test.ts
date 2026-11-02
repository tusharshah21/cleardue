import { describe, expect, it } from "vitest";
import { actionText, verdictText } from "./proposals";

describe("actionText", () => {
  it("names the AP contact instead of an address, in both forms", () => {
    const t = actionText("send_invoice_reminder", { additional_recipients: ["ap@acme.test"] }, "ap@acme.test");
    expect(`Autopilot ${t.done}`).toBe("Autopilot sent a PayPal reminder to the client and their AP contact");
    expect(t.doing).toBe("sending a PayPal reminder to the client and their AP contact");
    expect(actionText("send_invoice_reminder", {}, null).done).toBe("sent a PayPal reminder to the client");
  });

  it("never shows a tool's code name", () => {
    const types = ["send_invoice_reminder", "send_message", "pause_reminders", "offer_payment_plan", "apply_payment_plan", "escalate_dispute", "get_invoice", "cancel_sent_invoice", "record_payment_for_invoice", "manual_review", "something_new"];
    for (const type of types) {
      const t = actionText(type, { until: "2026-11-09", instalments: [{}, {}] }, null);
      expect(`${t.doing} ${t.done}`, type).not.toMatch(/_/);
    }
    expect(verdictText("needs_approval")).toBe("needs your approval");
  });
});
