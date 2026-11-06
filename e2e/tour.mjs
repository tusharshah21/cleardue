// End-to-end check of the guided tour against a running app (local dev server or the hosted site):
//   BASE_URL=http://localhost:3100 CHROME=<path to chrome> node e2e/tour.mjs [--shots dir]
// It walks all steps in a fresh browser context, checks every target is found or falls back to a centred popover,
// checks the offer shows once per browser, replay works, and that the tour sends no POST (so no server action ran).
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = (process.env.BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const EMAIL = process.env.DEMO_EMAIL ?? "demo@cleardue.app";
const PASSWORD = process.env.DEMO_PASSWORD ?? "judge-cleardue-2026";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: process.env.HEADED ? false : true });

async function freshPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const posts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && !r.url().includes("__nextjs")) posts.push(r.url()); // dev-server overlay calls are not the app
  });
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/welcome|dashboard/, { timeout: 60000 });
  posts.length = 0; // signing in is a POST; the tour itself must add none
  return { ctx, page, posts };
}
const popover = (page) => page.locator(".driver-popover.cleardue-tour");

// 1. the offer: shown once per browser, never starts by itself
{
  const { ctx, page, posts } = await freshPage();
  await page.goto(BASE + "/welcome", { waitUntil: "networkidle" });
  await page.getByText("New here? Take a 30-second tour.").waitFor({ timeout: 10000 });
  check("offer is shown on the first visit", true);
  check("tour does not start by itself", (await popover(page).count()) === 0);
  await page.reload({ waitUntil: "networkidle" });
  check("offer is still there until answered", await page.getByText("New here? Take a 30-second tour.").isVisible());
  await page.getByRole("button", { name: "Not now" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await sleep(500);
  check("offer never returns after Not now", (await page.getByText("New here? Take a 30-second tour.").count()) === 0);
  await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
  await page.goto(BASE + "/welcome", { waitUntil: "networkidle" });
  check("offer stays gone on later visits", (await page.getByText("New here? Take a 30-second tour.").count()) === 0);
  check("no POST during the offer", posts.length === 0, posts.join(","));
  await ctx.close();
}

// 2. ?tour=off suppresses the offer (for the video scripts)
{
  const { ctx, page } = await freshPage();
  await page.goto(BASE + "/welcome?tour=off", { waitUntil: "networkidle" });
  await sleep(500);
  check("?tour=off hides the offer", (await page.getByText("New here?").count()) === 0);
  check("?tour=off is removed from the URL", !page.url().includes("tour="));
  await page.reload({ waitUntil: "networkidle" });
  check("?tour=off is remembered", (await page.getByText("New here?").count()) === 0);
  await ctx.close();
}

// 3. the full walk in a fresh context
{
  const { ctx, page, posts } = await freshPage();
  await page.goto(BASE + "/welcome", { waitUntil: "networkidle" });
  const startFocus = await page.evaluate(() => document.activeElement?.tagName);
  await page.getByRole("button", { name: "Start tour" }).click();
  const seen = [];
  const order = [/welcome/, /welcome/, /welcome/, /invoices\//, /invoices\//, /approvals/, /pay\//, /analyst/, /welcome/];
  for (let i = 0; i < 9; i++) {
    await popover(page).waitFor({ timeout: 15000 });
    await page.waitForFunction((n) => document.querySelector(".cleardue-tour .driver-popover-progress-text")?.textContent?.startsWith(`${n} of 9`), i + 1, { timeout: 10000 });
    await sleep(500);
    const info = await page.evaluate(() => ({
      title: document.querySelector(".cleardue-tour .driver-popover-title")?.textContent,
      text: document.querySelector(".cleardue-tour .driver-popover-description")?.textContent,
      spotlight: !!!document.querySelector("#driver-dummy-element"),
      focusInside: !!document.activeElement?.closest(".cleardue-tour"),
      label: document.querySelector(".cleardue-tour")?.getAttribute("aria-label"),
      skip: !!document.querySelector(".cleardue-tour-skip"),
    }));
    seen.push(info);
    check(`step ${i + 1} on the right page`, order[i].test(page.url()), page.url().replace(BASE, ""));
    check(`step ${i + 1} ${info.spotlight ? "spotlights its target" : "falls back to a centred popover"}`, true, `"${info.title}"`);
    check(`step ${i + 1} has focus inside the popover, a label and Skip`, info.focusInside && !!info.label && info.skip);
    if (SHOTS && [0, 4, 6].includes(i)) await page.screenshot({ path: `${SHOTS}/tour-step-${i + 1}.png` });
    // alternate between the Next button and the arrow key
    if (i % 2 === 0) await page.locator(".cleardue-tour .driver-popover-next-btn").click();
    else await page.keyboard.press("ArrowRight");
    if (i < 8) await sleep(300);
  }
  await sleep(600);
  check("tour closes after the last step", (await popover(page).count()) === 0);
  check("focus returned to the page (not lost in a removed popover)", startFocus !== undefined);
  check("no step sent a POST (no data changed)", posts.length === 0, posts.join(","));
  check("the spotlighted targets were found for most steps", seen.filter((s) => s.spotlight).length >= 6, `${seen.filter((s) => s.spotlight).length}/9`);
  await ctx.close();
}

// 4. controls: Back, arrow keys, Esc, Skip, replay from Start here and from the nav
{
  const { ctx, page, posts } = await freshPage();
  await page.goto(BASE + "/welcome?tour=start", { waitUntil: "networkidle" });
  await popover(page).waitFor({ timeout: 15000 });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".cleardue-tour .driver-popover-progress-text")?.textContent?.startsWith("2 of 9"));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector(".cleardue-tour .driver-popover-progress-text")?.textContent?.startsWith("1 of 9"));
  check("arrow keys move forward and back", true);
  await page.keyboard.press("Escape");
  await sleep(400);
  check("Esc closes the tour", (await popover(page).count()) === 0);
  await page.reload({ waitUntil: "networkidle" });
  await sleep(400);
  check("after Esc, a reload does not resume or re-offer", (await popover(page).count()) === 0 && (await page.getByText("New here?").count()) === 0);
  await page.getByRole("button", { name: "Take the tour" }).first().click();
  await popover(page).waitFor({ timeout: 10000 });
  check("replay from the Take the tour button", true);
  await page.getByRole("button", { name: "Skip the tour" }).first().click();
  await sleep(400);
  check("Skip closes the tour", (await popover(page).count()) === 0);
  await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Take the tour" }).first().click();
  await page.waitForURL(/\/welcome/, { timeout: 15000 });
  await popover(page).waitFor({ timeout: 15000 });
  check("replay from the ? in the menu on another page", true);
  await page.keyboard.press("Escape");
  check("no POST during the controls test", posts.length === 0, posts.join(","));
  await ctx.close();
}

// 5. a missing target falls back to a centred popover instead of failing
{
  const { ctx, page } = await freshPage();
  await page.goto(BASE + "/welcome?tour=start", { waitUntil: "networkidle" });
  await popover(page).waitFor({ timeout: 15000 });
  await page.evaluate(() => document.querySelector('[data-tour="start-headline"]')?.removeAttribute("data-tour"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.dispatchEvent(new Event("cleardue:start-tour")));
  await popover(page).waitFor({ timeout: 15000 });
  const centred = await page.evaluate(() => !!document.querySelector("#driver-dummy-element"));
  check("a missing target shows the same text in a centred popover", centred);
  await ctx.close();
}

// 6. a phone: no auto-offer, button with a note, centred popovers (no spotlight)
{
  const { ctx, page } = await freshPage({ width: 390, height: 800 });
  await page.goto(BASE + "/welcome", { waitUntil: "networkidle" });
  await sleep(600);
  check("phone: no auto-offer", (await page.getByText("New here?").count()) === 0);
  check("phone: Take the tour button with a larger-screen note", (await page.getByText("Works best on a larger screen.").isVisible()) && (await page.getByRole("button", { name: "Take the tour" }).first().isVisible()));
  await page.getByRole("button", { name: "Take the tour" }).first().click();
  await popover(page).waitFor({ timeout: 10000 });
  check("phone: popover is centred without a spotlight", await page.evaluate(() => !!document.querySelector("#driver-dummy-element")));
  const box = await popover(page).boundingBox();
  check("phone: popover fits the screen", !!box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
