"use client";

// The guided tour. Spotlight + popover (Driver.js, MIT) over one element at a time; moves between pages only when the user
// presses Next or Back, and picks up again on the new page. It points and explains: the overlay blocks the page, the
// highlighted element is not interactive, and nothing here calls a server action.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { Button } from "@/components/ui/button";
import { clearProgress, markHandled, pageOfPath, pathForStep, readState, saveProgress, shouldOffer, STEPS, TOTAL, wantsStart, wantsSuppress, type TourLinks } from "@/lib/tour";

export const START_TOUR_EVENT = "cleardue:start-tour";
/** Ask the runner on the page to start the tour from step 1 (from the nav's ? item or the Take the tour button). */
export const startTour = () => window.dispatchEvent(new Event(START_TOUR_EVENT));

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const isNarrow = () => window.matchMedia("(max-width: 767px)").matches;
const find = (name: string) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`);

/** Driver.js adds classes to <body> and to the target, so never start while React is still hydrating the page (that causes a
 * hydration mismatch): wait for the load event, then a moment for the streamed parts to hydrate. Once per page load. */
let hydrated: Promise<void> | null = null;
const afterHydration = () =>
  (hydrated ??= new Promise<void>((resolve) => {
    const done = () => setTimeout(resolve, 600);
    if (document.readyState === "complete") done();
    else window.addEventListener("load", done, { once: true });
  }));

function linksOnPage(): TourLinks {
  const href = (n: string) => document.querySelector<HTMLAnchorElement>(`[data-tour="${n}"]`)?.getAttribute("href") ?? undefined;
  const links: TourLinks = {};
  const acme = href("open-acme");
  const koala = href("open-koala");
  if (acme) links.acme = acme;
  if (koala) links.koala = koala; // only what this page has: an empty value must not wipe a saved link
  return links;
}

export function TourRunner() {
  const pathname = usePathname();
  const router = useRouter();
  const showRef = useRef<(index: number) => Promise<void>>(async () => {});
  const active = useRef<Driver | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const runId = useRef(0);
  const [offer, setOffer] = useState(false);

  const stop = useCallback(() => {
    runId.current++; // any step still waiting for its target is cancelled
    cleanup.current?.();
    cleanup.current = null;
    const d = active.current;
    active.current = null;
    d?.destroy();
  }, []);

  const end = useCallback(() => {
    stop();
    clearProgress(storage());
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back && document.contains(back)) back.focus();
  }, [stop]);

  const show = useCallback(
    async (index: number) => {
      stop();
      const mine = ++runId.current;
      const step = STEPS[index];
      await afterHydration();
      if (mine !== runId.current) return;
      const narrow = isNarrow();
      let target: HTMLElement | null = null;
      let text = step.text;
      if (!narrow) {
        // Step 5 before the first diagnosis: no verdict exists yet, so point at the Diagnose area instead (never click it).
        // Both are on the page from the start, so the fallback is chosen after a short grace period, not a long wait.
        const t0 = Date.now();
        for (;;) {
          target = find(step.target);
          if (target) break;
          const alt = step.alt && Date.now() - t0 > 400 ? find(step.alt.target) : null;
          if (alt) {
            target = alt;
            text = step.alt!.text;
            break;
          }
          if (Date.now() - t0 > 2500) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (mine !== runId.current) return;
      const go = (to: number) => {
        stop();
        if (to < 0) return;
        if (to >= TOTAL) return end();
        const links = { ...readState(storage()).links, ...linksOnPage() };
        const dest = pathForStep(to, links);
        if (!dest || dest === window.location.pathname) {
          saveProgress(storage(), to, links);
          void showRef.current(to); // same page, or no link to follow: show it right here (centred if its target is missing)
        } else {
          saveProgress(storage(), to, links);
          window.location.href = dest;
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "ArrowRight") go(index + 1);
        else if (e.key === "ArrowLeft") go(index - 1);
        else if (e.key === "Escape") end();
        else return;
        e.preventDefault();
      };
      document.addEventListener("keydown", onKey);
      cleanup.current = () => document.removeEventListener("keydown", onKey);

      const last = index === TOTAL - 1;
      const d = driver({
        animate: true,
        overlayOpacity: 0.55,
        stagePadding: 6,
        stageRadius: 10,
        smoothScroll: true,
        allowClose: true,
        allowKeyboardControl: false,
        disableActiveInteraction: true,
        overlayClickBehavior: () => {},
        popoverClass: "cleardue-tour",
        showProgress: true,
        progressText: `${index + 1} of ${TOTAL}`,
        showButtons: index === 0 ? ["next", "close"] : ["previous", "next", "close"],
        nextBtnText: last ? "Done" : "Next",
        prevBtnText: "Back",
        doneBtnText: last ? "Done" : "Next", // each step is its own one-step tour, so Driver always treats it as the last
        onNextClick: () => go(index + 1),
        onPrevClick: () => go(index - 1),
        onCloseClick: () => end(),
        onPopoverRender: (popover) => {
          const wrap = popover.wrapper;
          wrap.setAttribute("role", "dialog");
          wrap.setAttribute("aria-modal", "false");
          wrap.setAttribute("aria-label", `Guided tour, step ${index + 1} of ${TOTAL}: ${step.title}`);
          wrap.setAttribute("tabindex", "-1");
          popover.nextButton.setAttribute("aria-label", last ? "Finish the tour" : `Next step, ${index + 2} of ${TOTAL}`);
          popover.previousButton.setAttribute("aria-label", "Previous step");
          popover.closeButton.setAttribute("aria-label", "Skip the tour");
          // A visible Skip next to Back and Next (the corner × does the same).
          if (!popover.footerButtons.querySelector(".cleardue-tour-skip")) {
            const skip = document.createElement("button");
            skip.type = "button";
            skip.className = "cleardue-tour-skip";
            skip.textContent = "Skip";
            skip.setAttribute("aria-label", "Skip the tour");
            skip.addEventListener("click", () => end());
            popover.footerButtons.prepend(skip);
          }
        },
        steps: [{ element: target ?? undefined, popover: { title: step.title, description: text, side: step.side, align: "center" } }],
      });
      active.current = d;
      d.drive();
      // Move focus into the popover so keyboard and screen-reader users land on it.
      requestAnimationFrame(() => (document.querySelector<HTMLElement>(".cleardue-tour .driver-popover-next-btn") ?? document.querySelector<HTMLElement>(".cleardue-tour"))?.focus());
    },
    [end, stop],
  );

  useEffect(() => {
    showRef.current = show;
  }, [show]);

  const begin = useCallback(() => {
    returnFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    markHandled(storage());
    saveProgress(storage(), 0, linksOnPage());
    void show(0);
  }, [show]);

  // On every page: resume a running tour, honour ?tour=off and ?tour=start, and offer the tour on Start here.
  useEffect(() => {
    const s = storage();
    const search = window.location.search;
    const clean = () => {
      const u = new URL(window.location.href);
      u.searchParams.delete("tour");
      window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    };
    if (wantsSuppress(search)) {
      markHandled(s);
      clearProgress(s);
      clean();
      return;
    }
    if (wantsStart(search)) {
      clean();
      begin();
      return;
    }
    const state = readState(s);
    if (state.step !== null) {
      if (pageOfPath(pathname) === STEPS[state.step].page || !pathForStep(state.step, state.links)) void show(state.step);
      else clearProgress(s); // the user wandered off by hand: drop the tour quietly
      return;
    }
    const offerNow = pathname === "/welcome" && !isNarrow() && shouldOffer(s);
    queueMicrotask(() => setOffer(offerNow));
  }, [pathname, begin, show]);

  useEffect(() => {
    const onStart = () => {
      if (pageOfPath(window.location.pathname) === "welcome") begin();
      else router.push("/welcome?tour=start");
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => {
      window.removeEventListener(START_TOUR_EVENT, onStart);
      stop();
    };
  }, [begin, stop, router]);

  if (!offer) return null;
  return (
    <section aria-label="Guided tour" className="fixed right-4 bottom-4 z-40 w-72 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
      <p className="text-sm font-medium">New here? Take a 30-second tour.</p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            setOffer(false);
            begin();
          }}
        >
          Start tour
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            markHandled(storage());
            setOffer(false);
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}

/** The "Take the tour" button on Start here. On a phone it says so: the tour is made for a larger screen. */
export function TakeTourButton() {
  return (
    <div className="inline-flex flex-wrap items-center gap-3" data-tour="take-tour">
      <Button type="button" variant="outline" onClick={startTour}>
        Take the tour
      </Button>
      <span className="text-xs text-muted-foreground md:hidden">Works best on a larger screen.</span>
    </div>
  );
}
