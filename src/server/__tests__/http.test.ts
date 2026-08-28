import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type express from "express";

// http.ts imports the auth tools, which import the OS keychain binding. Stub it.
vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn().mockImplementation(function () {
    return { getPassword: () => null, setPassword: () => {} };
  }),
}));

import { createApp } from "../http.js";

const KEY = "k".repeat(32);
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

interface Listening { base: string; close: () => Promise<void>; }

function listen(app: express.Express): Promise<Listening> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("HTTP auth gate with MCP_API_KEY set", () => {
  let srv: Listening;
  beforeAll(async () => { srv = await listen(createApp({ apiKey: KEY })); });
  afterAll(() => srv.close());

  it.each(["GET", "POST", "DELETE"])("%s /mcp without a key returns 401", async (method) => {
    const res = await fetch(`${srv.base}/mcp`, {
      method,
      headers: MCP_HEADERS,
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("GET /mcp (SSE stream request) without a key returns 401", async () => {
    const res = await fetch(`${srv.base}/mcp`, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key, a truncated key, and a non-bearer scheme", async () => {
    for (const authorization of [`Bearer ${"w".repeat(32)}`, `Bearer ${KEY.slice(0, -1)}`, `Basic ${KEY}`, KEY]) {
      const res = await fetch(`${srv.base}/mcp`, { headers: { ...MCP_HEADERS, Authorization: authorization } });
      expect(res.status, `Authorization: ${authorization}`).toBe(401);
    }
  });

  it("requires the key on unknown paths too (no route enumeration)", async () => {
    for (const path of ["/", "/sse", "/messages", "/mcp/", "/HEALTH", "/admin"]) {
      const res = await fetch(`${srv.base}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("lets a request with the correct key past the gate", async () => {
    const res = await fetch(`${srv.base}/mcp`, { headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY}` } });
    expect(res.status).not.toBe(401);
    await res.text();
  });

  it("keeps /health reachable without a key", async () => {
    const res = await fetch(`${srv.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("keeps /oauth/callback reachable for Clio's browser redirect", async () => {
    const res = await fetch(`${srv.base}/oauth/callback`);
    // Reaches the route (400 for missing code/state) instead of being blocked by the gate.
    expect(res.status).toBe(400);
    await res.text();
  });
});

describe("HTTP auth gate with the MCP_ALLOW_UNAUTHENTICATED opt-out", () => {
  let srv: Listening;
  beforeAll(async () => { srv = await listen(createApp({ apiKey: null })); });
  afterAll(() => srv.close());

  it("does not require a key on /mcp", async () => {
    const res = await fetch(`${srv.base}/mcp`, { headers: MCP_HEADERS });
    expect(res.status).not.toBe(401);
    await res.text();
  });

  it("still serves /health", async () => {
    const res = await fetch(`${srv.base}/health`);
    expect(res.status).toBe(200);
    await res.text();
  });
});

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
