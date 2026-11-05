// Anything about moving money outside the PayPal invoice: bank details, wires, Wise, UPI and the like. ClearDue only collects
// through the PayPal invoice, so a message that discusses another rail is never sent or shown on its own; the freelancer decides.
const RAIL = /\b(bank|iban|swift|bic|ifsc|neft|rtgs|imps|upi|ach|routing number|sort code|account number|wire|wise|transferwise|payoneer|western union|remitly|venmo|zelle|cash app|crypto|bitcoin|usdt|cheque|direct deposit|payment details|payment method|pay (?:you )?directly|outside (?:of )?paypal)\b/i;

export const mentionsPaymentRail = (text: string) => RAIL.test(text);
