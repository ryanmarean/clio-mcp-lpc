import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPatch, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const CUSTOM_FIELD_LIST_FIELDS = "id,name,parent_type,field_type,displayed,required,display_order,picklist_options{id,option}";
const CUSTOM_FIELD_VALUES_FIELDS = "custom_field_values{id,field_name,field_type,value}";

const FIELD_TYPES = ["checkbox", "contact", "currency", "date", "time", "email", "matter", "numeric", "picklist", "text_area", "text_line", "url"] as const;

const PARENT_PATH: Record<string, string> = { Matter: "matters", Contact: "contacts" };

export function registerCustomFieldTools(server: McpServer): void {
  server.registerTool(
    "list_custom_fields",
    {
      description: "List custom field definitions configured in Clio",
      inputSchema: {
        parent_type: z.enum(["Matter", "Contact"]).optional().describe("Filter to custom fields defined for this parent resource type"),
        field_type: z.enum(FIELD_TYPES).optional().describe("Filter by field type"),
        query: z.string().min(1).optional().describe("Wildcard search over custom field name"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_custom_fields response to fetch the next page"),
      },
    },
    async ({ parent_type, field_type, query, limit, page_token }) => {
      try {
        const params: Record<string, string> = { fields: CUSTOM_FIELD_LIST_FIELDS, limit: String(limit) };
        if (parent_type) params["parent_type"] = parent_type;
        if (field_type) params["field_type"] = field_type;
        if (query) params["query"] = query;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/custom_fields.json", params);
        const customFields = data.data as any[];
        const nextPageToken = customFields.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_custom_fields",
          args: { parent_type, field_type, query, limit, page_token },
          outcome: "success",
          result_count: customFields?.length ?? 0,
        });

        if (!customFields || customFields.length === 0) {
          return { content: [{ type: "text", text: "No custom fields found." }] };
        }

        const result = {
          custom_fields: customFields.map((f) => ({
            id: f.id,
            name: f.name,
            parent_type: f.parent_type,
            field_type: f.field_type,
            displayed: f.displayed,
            required: f.required,
            display_order: f.display_order,
            picklist_options: (f.picklist_options ?? []).map((o: any) => ({ id: o.id, option: o.option })),
          })),
          total_count: data.meta?.records ?? customFields.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_custom_fields",
          args: { parent_type, field_type, query, limit, page_token },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_custom_field_values",
    {
      description: "Get the current custom field values on a Clio matter or contact",
      inputSchema: {
        parent_type: z.enum(["Matter", "Contact"]).describe("Type of record the custom field values belong to"),
        parent_id: z.number().int().positive().describe("ID of the matter or contact"),
      },
    },
    async ({ parent_type, parent_id }) => {
      const auditMatterId = parent_type === "Matter" ? parent_id : undefined;
      try {
        const data = await clioGet(`/${PARENT_PATH[parent_type]}/${parent_id}.json`, { fields: CUSTOM_FIELD_VALUES_FIELDS });
        const values = (data.data?.custom_field_values ?? []) as any[];

        await appendAuditLog({
          tool: "get_custom_field_values",
          args: { parent_type, parent_id },
          outcome: "success",
          result_count: values.length,
          ...(auditMatterId && { matter_id: auditMatterId }),
        });

        const result = {
          parent_type,
          parent_id,
          custom_field_values: values.map((v) => ({ id: v.id, field_name: v.field_name, field_type: v.field_type, value: v.value })),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_custom_field_values", args: { parent_type, parent_id }, outcome: "success", ...(auditMatterId && { matter_id: auditMatterId }) });
          return { content: [{ type: "text", text: `${parent_type} ${parent_id} not found.` }] };
        }
        await appendAuditLog({
          tool: "get_custom_field_values",
          args: { parent_type, parent_id },
          outcome: "error",
          error_message: err.message,
          ...(auditMatterId && { matter_id: auditMatterId }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "set_custom_field_values",
    {
      description: "Set one or more custom field values on a Clio matter or contact",
      inputSchema: {
        parent_type: z.enum(["Matter", "Contact"]).describe("Type of record to update"),
        parent_id: z.number().int().positive().describe("ID of the matter or contact"),
        values: z.array(z.object({
          custom_field_id: z.number().int().positive().describe("ID of the custom field definition (from list_custom_fields)"),
          value: z.string().describe("The value to set. For picklist fields, use the option text; for checkbox fields, use \"true\"/\"false\"."),
        })).min(1).describe("Custom field values to set"),
      },
    },
    async ({ parent_type, parent_id, values }) => {
      const auditMatterId = parent_type === "Matter" ? parent_id : undefined;
      try {
        const path = `/${PARENT_PATH[parent_type]}/${parent_id}.json?${new URLSearchParams({ fields: CUSTOM_FIELD_VALUES_FIELDS }).toString()}`;
        const payload = {
          data: {
            custom_field_values: values.map((v) => ({ custom_field: { id: v.custom_field_id }, value: v.value })),
          },
        };

        const data = await clioPatch(path, payload);
        const updatedValues = (data.data?.custom_field_values ?? []) as any[];

        await appendAuditLog({
          tool: "set_custom_field_values",
          args: { parent_type, parent_id, custom_field_ids: values.map((v) => v.custom_field_id) },
          outcome: "success",
          ...(auditMatterId && { matter_id: auditMatterId }),
        });

        const result = {
          success: true,
          parent_type,
          parent_id,
          custom_field_values: updatedValues.map((v) => ({ id: v.id, field_name: v.field_name, field_type: v.field_type, value: v.value })),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "set_custom_field_values", args: { parent_type, parent_id }, outcome: "success", ...(auditMatterId && { matter_id: auditMatterId }) });
          return { content: [{ type: "text", text: `${parent_type} ${parent_id} not found.` }] };
        }
        await appendAuditLog({
          tool: "set_custom_field_values",
          args: { parent_type, parent_id, custom_field_ids: values.map((v) => v.custom_field_id) },
          outcome: "error",
          error_message: err.message,
          ...(auditMatterId && { matter_id: auditMatterId }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
