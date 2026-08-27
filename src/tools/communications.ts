import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { toIso } from "./calendar.js";

const COMMUNICATION_LIST_FIELDS =
  "id,subject,body,type,date,received_at,matter{id,display_number},senders{id,name,type},receivers{id,name,type}";

const TYPE_MAP: Record<string, string> = { Email: "EmailCommunication", Phone: "PhoneCommunication" };

export function registerCommunicationTools(server: McpServer): void {
  server.registerTool(
    "list_communications",
    {
      description: "List/search logged communications (emails, calls) from Clio with optional filters",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter communications by matter ID"),
        contact_id: z.number().int().positive().optional().describe("Filter communications by contact ID"),
        type: z.enum(["Email", "Phone"]).optional().describe("Filter by communication type"),
        query: z.string().min(1).optional().describe("Wildcard search over subject/body text"),
        date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — communications received on or after this date"),
        date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — communications received on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_communications response to fetch the next page"),
      },
    },
    async ({ matter_id, contact_id, type, query, date_start, date_end, limit, page_token }) => {
      try {
        const params: Record<string, string> = { fields: COMMUNICATION_LIST_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (contact_id) params["contact_id"] = String(contact_id);
        if (type) params["type"] = TYPE_MAP[type];
        if (query) params["query"] = query;
        if (date_start) params["received_since"] = date_start;
        if (date_end) params["received_before"] = date_end;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/communications.json", params);
        const communications = data.data as any[];
        const nextPageToken = communications.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_communications",
          args: { matter_id, contact_id, type, query, date_start, date_end, limit, page_token },
          outcome: "success",
          result_count: communications?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        if (!communications || communications.length === 0) {
          return { content: [{ type: "text", text: "No communications found." }] };
        }

        const result = {
          communications: communications.map((c) => ({
            id: c.id,
            subject: c.subject,
            type: c.type,
            date: c.date,
            received_at: c.received_at,
            matter: c.matter ? { id: c.matter.id, display_number: c.matter.display_number } : null,
            senders: (c.senders ?? []).map((s: any) => ({ id: s.id, name: s.name, type: s.type })),
            receivers: (c.receivers ?? []).map((r: any) => ({ id: r.id, name: r.name, type: r.type })),
            body: c.body,
          })),
          total_count: data.meta?.records ?? communications.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_communications",
          args: { matter_id, contact_id, type, query, date_start, date_end, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_communication",
    {
      description: "Log a new communication (email or call) in Clio, optionally attached to a matter",
      inputSchema: {
        type: z.enum(["Email", "Phone"]).describe("Type of communication being logged"),
        subject: z.string().min(1).describe("Communication subject / title"),
        body: z.string().min(1).describe("Communication body text"),
        received_at: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).describe("Date or datetime in local time — YYYY-MM-DD, YYYY-MM-DDTHH:MM, or YYYY-MM-DDTHH:MM:SS"),
        matter_id: z.number().int().positive().optional().describe("Matter ID to associate the communication with"),
        sender_contact_ids: z.array(z.number().int().positive()).optional().describe("Clio contact IDs of the sender(s)"),
        receiver_contact_ids: z.array(z.number().int().positive()).optional().describe("Clio contact IDs of the receiver(s)"),
      },
    },
    async ({ type, subject, body: bodyText, received_at, matter_id, sender_contact_ids, receiver_contact_ids }) => {
      try {
        const communicationData: Record<string, unknown> = {
          type: TYPE_MAP[type],
          subject,
          body: bodyText,
          received_at: toIso(received_at),
        };
        if (matter_id) communicationData["matter"] = { id: matter_id };
        if (sender_contact_ids?.length) communicationData["senders"] = sender_contact_ids.map((id) => ({ id, type: "Contact" }));
        if (receiver_contact_ids?.length) communicationData["receivers"] = receiver_contact_ids.map((id) => ({ id, type: "Contact" }));

        const data = await clioPost("/communications.json", { data: communicationData });
        const communication = data.data;

        await appendAuditLog({
          tool: "create_communication",
          args: { type, subject, received_at, matter_id, sender_contact_ids, receiver_contact_ids },
          outcome: "success",
          ...(matter_id && { matter_id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              communication: {
                id: communication.id,
                subject: communication.subject,
                type: communication.type,
                received_at: communication.received_at,
                matter_id: matter_id ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "create_communication",
          args: { type, subject, received_at, matter_id, sender_contact_ids, receiver_contact_ids },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
