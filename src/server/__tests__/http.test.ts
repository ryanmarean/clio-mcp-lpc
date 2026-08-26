import { vi, describe, it, expect } from "vitest";

// Each test re-imports http.ts under vi.resetModules() to get a fresh
// SESSION_IDLE_TIMEOUT_MS for a different env value; the first dynamic import
// pays a one-time module-transform cost that can exceed the default 5s timeout.
vi.setConfig({ testTimeout: 15000 });

const HOUR_MS = 60 * 60 * 1000;

async function freshHttpModule(sessionIdleTimeoutHours: string | undefined) {
  vi.resetModules();
  if (sessionIdleTimeoutHours === undefined) {
    delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
  } else {
    process.env.SESSION_IDLE_TIMEOUT_HOURS = sessionIdleTimeoutHours;
  }
  return import("../http.js");
}

describe("SESSION_IDLE_TIMEOUT_MS", () => {
  it("defaults to 30 days when SESSION_IDLE_TIMEOUT_HOURS is unset", async () => {
    const { SESSION_IDLE_TIMEOUT_MS } = await freshHttpModule(undefined);
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(720 * HOUR_MS);
  });

  it("respects SESSION_IDLE_TIMEOUT_HOURS when set", async () => {
    const { SESSION_IDLE_TIMEOUT_MS } = await freshHttpModule("2");
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(2 * HOUR_MS);
  });

  it("falls back to the default for a non-numeric value", async () => {
    const { SESSION_IDLE_TIMEOUT_MS } = await freshHttpModule("not-a-number");
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(720 * HOUR_MS);
  });
});

describe("isSessionStale", () => {
  it("is not stale while inside the idle window", async () => {
    const { isSessionStale } = await freshHttpModule(undefined);
    const now = Date.now();
    const record = { lastActivityAt: now - 1 * HOUR_MS };
    expect(isSessionStale(record, now, 24 * HOUR_MS)).toBe(false);
  });

  it("becomes stale once inactivity exceeds the idle window", async () => {
    const { isSessionStale } = await freshHttpModule(undefined);
    const now = Date.now();
    const record = { lastActivityAt: now - 25 * HOUR_MS };
    expect(isSessionStale(record, now, 24 * HOUR_MS)).toBe(true);
  });

  it("stays alive under a long idle window even if the session is old but recently active", async () => {
    const { isSessionStale } = await freshHttpModule(undefined);
    const now = Date.now();
    // Active 1 hour ago, well within a 30-day window — must not be evicted
    // just because the session itself is older than the old 24h cutoff.
    const record = { lastActivityAt: now - 1 * HOUR_MS };
    expect(isSessionStale(record, now, 720 * HOUR_MS)).toBe(false);
  });
});
