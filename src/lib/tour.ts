// Guided tour: the steps, and the small state machine behind "offer once per browser, resume across pages".
// State lives in the browser's localStorage (not the account: judges share one demo account). Every storage call is
// wrapped, so a browser that blocks storage simply never auto-offers and the tour never resumes.

export const TOUR_KEY = "cleardue.tour.v1";

export type TourPage = "welcome" | "acme" | "approvals" | "pay" | "analyst";

export interface TourStep {
  id: string;
  page: TourPage;
  /** The element's data-tour attribute. */
  target: string;
  title: string;
  text: string;
  side: "top" | "bottom" | "left" | "right";
  /** Used instead of target and text when the target is missing but this one is there (step 5 before a diagnosis). */
  alt?: { target: string; text: string };
}

export const STEPS: TourStep[] = [
  { id: "headline", page: "welcome", target: "start-headline", title: "What ClearDue does", text: "ClearDue finds out why a client hasn't paid and acts through PayPal, within limits you set.", side: "bottom" },
  { id: "stories", page: "welcome", target: "story-cards", title: "Four stories", text: "Four short stories, about a minute each.", side: "top" },
  { id: "reset", page: "welcome", target: "reset-demo", title: "Replay a story", text: "If a story was already played, reset it here.", side: "top" },
  { id: "diagnosis", page: "acme", target: "diagnosis", title: "The diagnosis", text: "Diagnose reads the client's reply and names the reason, quoting their words.", side: "bottom" },
  {
    id: "mandate",
    page: "acme",
    target: "mandate-verdict",
    title: "The mandate decides",
    text: "Every action is checked against your limits in code before PayPal is touched.",
    side: "left",
    alt: { target: "diagnose-button", text: "Click Diagnose now to see the verdict here." },
  },
  { id: "approvals", page: "approvals", target: "approvals", title: "Approvals", text: "Anything outside your limits waits here for you. Recent decisions show what ran, what waited and what was blocked.", side: "bottom" },
  { id: "pay", page: "pay", target: "pay-card", title: "The client's pay page", text: "What your client sees: answers only from the agreed scope, with quotes, and a Pay with PayPal button per invoice or plan part.", side: "left" },
  {
    id: "analyst",
    page: "analyst",
    target: "collection-rate",
    title: "The analyst",
    text: "Collection rate is paid invoices divided by issued ones. Click a client or pick dates and every widget follows. Ask the analyst anything; its suggestions go to Approvals.",
    side: "bottom",
  },
  { id: "finish", page: "welcome", target: "take-tour", title: "Replay any time", text: "Replay this tour any time from here or the ? in the menu.", side: "bottom" },
];

export const TOTAL = STEPS.length;

export interface TourLinks {
  acme?: string;
  koala?: string;
}

export interface TourState {
  /** The prompt was answered (Start tour or Not now), or suppressed with ?tour=off: never offer again in this browser. */
  handled: boolean;
  /** Step to show on the next page load while a tour is running, else null. */
  step: number | null;
  links: TourLinks;
}

const EMPTY: TourState = { handled: false, step: null, links: {} };

/** True when reads and writes both work (a browser can throw on access, or accept reads and refuse writes). */
export function storageWorks(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined | null): boolean {
  if (!storage) return false;
  try {
    const k = `${TOUR_KEY}.probe`;
    storage.setItem(k, "1");
    storage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readState(storage: Store | undefined | null): TourState {
  try {
    const raw = storage?.getItem(TOUR_KEY);
    if (!raw) return { ...EMPTY, links: {} };
    const v = JSON.parse(raw) as Partial<TourState>;
    return {
      handled: v.handled === true,
      step: typeof v.step === "number" && v.step >= 0 && v.step < TOTAL ? v.step : null,
      links: v.links && typeof v.links === "object" ? { acme: typeof v.links.acme === "string" ? v.links.acme : undefined, koala: typeof v.links.koala === "string" ? v.links.koala : undefined } : {},
    };
  } catch {
    return { ...EMPTY, links: {} };
  }
}

function write(storage: Store | undefined | null, state: TourState): boolean {
  try {
    storage?.setItem(TOUR_KEY, JSON.stringify(state));
    return !!storage;
  } catch {
    return false;
  }
}

/** First visit in this browser, storage works, and no tour is half-way: show the small prompt. Never starts the tour by itself. */
export function shouldOffer(storage: Store | undefined | null): boolean {
  if (!storageWorks(storage)) return false;
  const s = readState(storage);
  return !s.handled && s.step === null;
}

/** "Start tour", "Not now" and ?tour=off all end the offer for good in this browser. */
export function markHandled(storage: Store | undefined | null): void {
  write(storage, { ...readState(storage), handled: true });
}

/** Remember where the tour is (and the links to the pages that have ids) before moving to another page. */
export function saveProgress(storage: Store | undefined | null, step: number, links?: TourLinks): void {
  const s = readState(storage);
  write(storage, { ...s, handled: true, step, links: { ...s.links, ...links } });
}

export function clearProgress(storage: Store | undefined | null): void {
  write(storage, { ...readState(storage), handled: true, step: null });
}

/** ?tour=off marks the offer as handled (for the demo-video scripts and anyone who doesn't want it). */
export const wantsSuppress = (search: string) => new URLSearchParams(search).get("tour") === "off";
export const wantsStart = (search: string) => new URLSearchParams(search).get("tour") === "start";

export function pageOfPath(pathname: string): TourPage | null {
  if (pathname === "/welcome") return "welcome";
  if (pathname.startsWith("/invoices/") && pathname !== "/invoices/new") return "acme";
  if (pathname === "/approvals") return "approvals";
  if (pathname.startsWith("/pay/")) return "pay";
  if (pathname === "/analyst") return "analyst";
  return null;
}

/** Where a step lives. undefined = no link known (the tour then shows the step where it is, as a centred popover). */
export function pathForStep(step: number, links: TourLinks): string | undefined {
  switch (STEPS[step]?.page) {
    case "welcome":
      return "/welcome";
    case "acme":
      return links.acme;
    case "approvals":
      return "/approvals";
    case "pay":
      return links.koala;
    case "analyst":
      return "/analyst";
    default:
      return undefined;
  }
}
