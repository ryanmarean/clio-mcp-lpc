import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockClioPost, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost };
});

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerCommunicationTools } from "../communications.js";

const COMMUNICATION_FIXTURE = {
  id: 1,
  subject: "Follow-up call",
  body: "Discussed settlement terms.",
  type: "PhoneCommunication",
  date: "2026-06-01",
  received_at: "2026-06-01T09:00:00",
  matter: { id: 99, display_number: "M-099" },
  senders: [{ id: 5, name: "Jane Attorney", type: "User" }],
  receivers: [{ id: 42, name: "John Client", type: "Contact" }],
};

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>();

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<any>) => {
      handlers.set(name, handler);
    },
  };
  registerCommunicationTools(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

// ─── list_communications ───────────────────────────────────────────────────

describe("list_communications", () => {
  it("returns a friendly message when no results are found", async () => {
    mockClioGet.mockResolvedValue({ data: [] });
    const handler = handlers.get("list_communications")!;
    const result = await handler({ limit: 25 }) as any;
    expect(result.content[0].text).toBe("No communications found.");
  });

  it("translates type 'Email' to 'EmailCommunication' and maps date_start/date_end to received_since/received_before", async () => {
    mockClioGet.mockResolvedValue({ data: [COMMUNICATION_FIXTURE] });
    const handler = handlers.get("list_communications")!;
    await handler({ type: "Email", date_start: "2026-06-01", date_end: "2026-06-30", limit: 25 });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/communications.json",
      expect.objectContaining({ type: "EmailCommunication", received_since: "2026-06-01", received_before: "2026-06-30" }),
    );
  });

  it("sets has_more and next_page_token when the result count reaches the limit", async () => {
    mockClioGet.mockResolvedValue({
      data: [COMMUNICATION_FIXTURE],
      meta: { paging: { next: "https://app.clio.com/api/v4/communications.json?page_token=abc123" } },
    });
    const handler = handlers.get("list_communications")!;
    const result = await handler({ limit: 1 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("logs an error and returns isError when clioGet throws", async () => {
    mockClioGet.mockRejectedValue(new Error("boom"));
    const handler = handlers.get("list_communications")!;
    const result = await handler({ limit: 25 }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "list_communications", outcome: "error" }));
  });
});

// ─── create_communication ──────────────────────────────────────────────────

describe("create_communication", () => {
  const baseArgs = { type: "Phone" as const, subject: "Follow-up call", body: "Discussed settlement terms.", received_at: "2026-06-01T09:00" };

  it("translates type 'Phone' to 'PhoneCommunication' and expands received_at via toIso", async () => {
    mockClioPost.mockResolvedValue({ data: COMMUNICATION_FIXTURE });
    const handler = handlers.get("create_communication")!;
    await handler(baseArgs);
    expect(mockClioPost).toHaveBeenCalledWith(
      "/communications.json",
      expect.objectContaining({ data: expect.objectContaining({ type: "PhoneCommunication", received_at: "2026-06-01T09:00:00" }) }),
    );
  });

  it("omits matter/senders/receivers from the payload when not provided", async () => {
    mockClioPost.mockResolvedValue({ data: COMMUNICATION_FIXTURE });
    const handler = handlers.get("create_communication")!;
    await handler(baseArgs);
    const [, payload] = mockClioPost.mock.calls[0];
    expect(payload.data).not.toHaveProperty("matter");
    expect(payload.data).not.toHaveProperty("senders");
    expect(payload.data).not.toHaveProperty("receivers");
  });

  it("builds senders/receivers as Contact-typed entries from sender_contact_ids/receiver_contact_ids", async () => {
    mockClioPost.mockResolvedValue({ data: COMMUNICATION_FIXTURE });
    const handler = handlers.get("create_communication")!;
    await handler({ ...baseArgs, matter_id: 99, sender_contact_ids: [1, 2], receiver_contact_ids: [3] });
    expect(mockClioPost).toHaveBeenCalledWith(
      "/communications.json",
      expect.objectContaining({
        data: expect.objectContaining({
          matter: { id: 99 },
          senders: [{ id: 1, type: "Contact" }, { id: 2, type: "Contact" }],
          receivers: [{ id: 3, type: "Contact" }],
        }),
      }),
    );
  });

  it("logs an error and returns isError when clioPost throws", async () => {
    mockClioPost.mockRejectedValue(new Error("boom"));
    const handler = handlers.get("create_communication")!;
    const result = await handler(baseArgs) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "create_communication", outcome: "error" }));
  });
});
