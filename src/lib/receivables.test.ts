import { describe, expect, it } from "vitest";
import { daysOverdue, isHeld, isOpen, outstanding } from "./receivables";

const inv = (status: string) => ({ status, dueDate: new Date("2026-11-01T00:00:00Z"), totalMinor: 90_000, paidMinor: 0, currency: "GBP" });
const now = new Date("2026-11-10T12:00:00Z");

describe("a payment PayPal is holding", () => {
  it("is still owed (the money has not arrived) but is never overdue, because the client has paid", () => {
    const held = inv("PAYMENT_PENDING");
    expect(isHeld(held)).toBe(true);
    expect(isOpen(held)).toBe(true);
    expect(outstanding(held)).toBe(90_000);
    expect(daysOverdue(held, now)).toBe(0);
  });
  it("leaves ordinary open invoices alone", () => {
    expect(daysOverdue(inv("SENT"), now)).toBe(9);
    expect(isHeld(inv("SENT"))).toBe(false);
  });
});
