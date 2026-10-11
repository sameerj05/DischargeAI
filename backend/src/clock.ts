/**
 * The app clock. Every timestamp the backend produces or compares comes from here. `DEMO_NOW=<ISO>`
 * pins the clock to that moment at boot (the offset to real time is kept, so the clock still ticks),
 * which is how the sweep script and a demo server show day 30 without waiting a month. There is no
 * HTTP surface for moving the clock; it is a process-level setting.
 */
export class Clock {
  private offsetMs = 0;
  readonly demoNow: string | null;

  constructor(demoNow?: string | null) {
    this.demoNow = demoNow ?? null;
    if (demoNow) {
      const t = Date.parse(demoNow);
      if (Number.isNaN(t)) throw new Error(`DEMO_NOW is not an ISO-8601 timestamp: ${demoNow}`);
      this.offsetMs = t - Date.now();
    }
  }

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Epoch seconds, the unit DynamoDB TTL expects. */
  nowEpochSeconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** Tests move the clock in process; production never calls these. */
  advanceDays(days: number): void {
    this.offsetMs += days * 24 * 60 * 60 * 1000;
  }

  advanceMs(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.offsetMs = 0;
  }

  get offsetDays(): number {
    return Math.round((this.offsetMs / (24 * 60 * 60 * 1000)) * 1000) / 1000;
  }
}
