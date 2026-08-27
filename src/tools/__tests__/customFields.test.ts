import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockClioPatch, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    mockClioGet: vi.fn(),
    mockClioPatch: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPatch: mockClioPatch, ClioApiError: MockClioApiError };
});

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerCustomFieldTools } from "../customFields.js";

const CUSTOM_FIELD_FIXTURE = {
  id: 10,
  name: "Referral Source",
  parent_type: "Matter",
  field_type: "picklist",
  displayed: true,
  required: false,
  display_order: 1,
  picklist_options: [{ id: 100, option: "Google" }, { id: 101, option: "Referral" }],
};

const CUSTOM_FIELD_VALUE_FIXTURE = { id: "20", field_name: "Referral Source", field_type: "picklist", value: "Referral" };

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>();

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<any>) => {
      handlers.set(name, handler);
    },
  };
  registerCustomFieldTools(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

// ─── list_custom_fields ─────────────────────────────────────────────────────

describe("list_custom_fields", () => {
  it("returns a friendly message when no results are found", async () => {
    mockClioGet.mockResolvedValue({ data: [] });
    const handler = handlers.get("list_custom_fields")!;
    const result = await handler({ limit: 25 }) as any;
    expect(result.content[0].text).toBe("No custom fields found.");
  });

  it("passes parent_type and field_type filters through unchanged", async () => {
    mockClioGet.mockResolvedValue({ data: [CUSTOM_FIELD_FIXTURE] });
    const handler = handlers.get("list_custom_fields")!;
    await handler({ parent_type: "Matter", field_type: "picklist", limit: 25 });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/custom_fields.json",
      expect.objectContaining({ parent_type: "Matter", field_type: "picklist" }),
    );
  });

  it("includes picklist_options in the mapped result", async () => {
    mockClioGet.mockResolvedValue({ data: [CUSTOM_FIELD_FIXTURE] });
    const handler = handlers.get("list_custom_fields")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.custom_fields[0].picklist_options).toEqual([{ id: 100, option: "Google" }, { id: 101, option: "Referral" }]);
  });
});

// ─── get_custom_field_values ────────────────────────────────────────────────

describe("get_custom_field_values", () => {
  it("requests the matters endpoint when parent_type is Matter", async () => {
    mockClioGet.mockResolvedValue({ data: { custom_field_values: [CUSTOM_FIELD_VALUE_FIXTURE] } });
    const handler = handlers.get("get_custom_field_values")!;
    await handler({ parent_type: "Matter", parent_id: 99 });
    expect(mockClioGet).toHaveBeenCalledWith("/matters/99.json", expect.objectContaining({ fields: expect.stringContaining("custom_field_values") }));
  });

  it("requests the contacts endpoint when parent_type is Contact", async () => {
    mockClioGet.mockResolvedValue({ data: { custom_field_values: [] } });
    const handler = handlers.get("get_custom_field_values")!;
    await handler({ parent_type: "Contact", parent_id: 42 });
    expect(mockClioGet).toHaveBeenCalledWith("/contacts/42.json", expect.any(Object));
  });

  it("returns a friendly not-found message and logs success on a 404", async () => {
    mockClioGet.mockRejectedValue(new MockClioApiError(404, "not found"));
    const handler = handlers.get("get_custom_field_values")!;
    const result = await handler({ parent_type: "Matter", parent_id: 999 }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Matter 999 not found.");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", matter_id: 999 }));
  });

  it("logs an error and returns isError on a non-404 failure", async () => {
    mockClioGet.mockRejectedValue(new Error("boom"));
    const handler = handlers.get("get_custom_field_values")!;
    const result = await handler({ parent_type: "Matter", parent_id: 99 }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_custom_field_values", outcome: "error" }));
  });
});

// ─── set_custom_field_values ────────────────────────────────────────────────

describe("set_custom_field_values", () => {
  it("PATCHes the matters endpoint with custom_field/value pairs", async () => {
    mockClioPatch.mockResolvedValue({ data: { custom_field_values: [CUSTOM_FIELD_VALUE_FIXTURE] } });
    const handler = handlers.get("set_custom_field_values")!;
    await handler({ parent_type: "Matter", parent_id: 99, values: [{ custom_field_id: 10, value: "Referral" }] });
    const [path, payload] = mockClioPatch.mock.calls[0];
    expect(path).toContain("/matters/99.json?fields=");
    expect(payload).toEqual({ data: { custom_field_values: [{ custom_field: { id: 10 }, value: "Referral" }] } });
  });

  it("PATCHes the contacts endpoint when parent_type is Contact", async () => {
    mockClioPatch.mockResolvedValue({ data: { custom_field_values: [] } });
    const handler = handlers.get("set_custom_field_values")!;
    await handler({ parent_type: "Contact", parent_id: 42, values: [{ custom_field_id: 11, value: "true" }] });
    const [path] = mockClioPatch.mock.calls[0];
    expect(path).toContain("/contacts/42.json?fields=");
  });

  it("does not include raw values in the audit log args, only custom_field_ids", async () => {
    mockClioPatch.mockResolvedValue({ data: { custom_field_values: [] } });
    const handler = handlers.get("set_custom_field_values")!;
    await handler({ parent_type: "Matter", parent_id: 99, values: [{ custom_field_id: 10, value: "sensitive-value" }] });
    const auditCall = mockAppendAuditLog.mock.calls[0][0];
    expect(auditCall.args).toEqual({ parent_type: "Matter", parent_id: 99, custom_field_ids: [10] });
  });

  it("returns a friendly not-found message and logs success on a 404", async () => {
    mockClioPatch.mockRejectedValue(new MockClioApiError(404, "not found"));
    const handler = handlers.get("set_custom_field_values")!;
    const result = await handler({ parent_type: "Contact", parent_id: 999, values: [{ custom_field_id: 10, value: "x" }] }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Contact 999 not found.");
  });

  it("logs an error and returns isError on a non-404 failure", async () => {
    mockClioPatch.mockRejectedValue(new Error("boom"));
    const handler = handlers.get("set_custom_field_values")!;
    const result = await handler({ parent_type: "Matter", parent_id: 99, values: [{ custom_field_id: 10, value: "x" }] }) as any;
    expect(result.isError).toBe(true);
  });
});
