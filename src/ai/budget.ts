// An overall time budget for one user action. Every model call in the action draws its abort signal from the same
// budget, so retries, failover and tool steps together can never run longer than the action's allowance.
export const DIAGNOSE_BUDGET_MS = 45_000;
export const ANSWER_BUDGET_MS = 20_000;

export class Budget {
  private readonly deadline: number;
  constructor(
    readonly totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + totalMs;
  }
  remainingMs = () => Math.max(0, this.deadline - this.now());
  exhausted = () => this.remainingMs() <= 0;
  /** A signal that fires at the earlier of `capMs` (one call's own cap) and the end of the budget. */
  signal = (capMs: number) => AbortSignal.timeout(Math.max(1, Math.min(capMs, this.remainingMs())));
  readonly exhaustedMessage = `time budget of ${Math.round(this.totalMs / 1000)}s used up`;
}
