// Demo seed: resets the demo freelancer to the three ClearDue stories (src/lib/demo-seed.ts).
//   npm run seed           local data only (no PayPal calls)
//   npm run seed:paypal    also creates and sends real sandbox invoices (needs PAYPAL_* and SEED_CLIENT_EMAIL),
//                          cancelling the open sandbox invoices from the previous seed first
import "dotenv/config";
import { resetDemo } from "../src/lib/demo-seed";
import { db } from "../src/lib/db";
import { isMockMode } from "../src/paypal/client";

// In PAYPAL_MODE=mock the seed always goes through (mock) PayPal, so every flow works locally.
const withPayPal = process.argv.includes("--paypal") || isMockMode();

resetDemo({ withPayPal })
  .then(async ({ closed, seeded }) => {
    if (closed) console.log(`Closed ${closed} open PayPal invoice(s) from the previous seed`);
    for (const line of seeded) console.log(`Seeded ${line}`);
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
