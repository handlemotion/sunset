import type * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@sunset/domain";

function textFromContent(content: acp.ContentBlock): string {
  if (content.type === "text") return content.text;
  return "";
}

function toolName(title: string, name?: string | null): string {
  return name?.trim() || title || "tool";
}

function terminalToolResult(update: acp.ToolCallUpdate): AgentEvent | null {
  if (update.status !== "completed" && update.status !== "failed") return null;
  return {
    type: "tool_result",
    callId: update.toolCallId,
    name: toolName(update.title ?? "", update.name),
    result: update.rawOutput ?? update.content ?? null,
    ok: update.status === "completed",
  };
}

export function mapSessionUpdate(update: acp.SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return text ? [{ type: "thought_delta", text }] : [];
    }
    case "user_message_chunk":
      return [];
    case "tool_call": {
      const call: AgentEvent = {
        type: "tool_call",
        callId: update.toolCallId,
        name: toolName(update.title, update.name),
        args: update.rawInput ?? null,
      };
      const result =
        update.status === "completed" || update.status === "failed"
          ? terminalToolResult({
              toolCallId: update.toolCallId,
              title: update.title,
              name: update.name,
              status: update.status,
              content: update.content,
              rawOutput: update.rawOutput,
            })
          : null;
      return result ? [call, result] : [call];
    }
    case "tool_call_update": {
      const result = terminalToolResult(update);
      if (result) return [result];
      if (update.status === "in_progress" || update.status === "pending") {
        return [
          {
            type: "status",
            status: `tool_${update.status}`,
            message: update.title ?? undefined,
          },
        ];
      }
      return [];
    }
    case "plan":
      return [
        {
          type: "plan",
          entries: update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status,
            ...(entry.priority ? { priority: entry.priority } : {}),
          })),
        },
      ];
    case "current_mode_update":
      return [{ type: "mode", modeId: update.currentModeId }];
    case "available_commands_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
    case "compaction_update":
    case "compaction_summary_chunk":
    case "plan_update":
    case "plan_removed":
      return [];
    default:
      return [];
  }
}

export function asAgentEvent(value: unknown): AgentEvent | null {
  if (typeof value !== "object" || value === null || !("type" in value))
    return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "text_delta":
    case "thought_delta":
      return typeof record.text === "string"
        ? { type: record.type, text: record.text }
        : null;
    case "tool_call":
      return typeof record.callId === "string" &&
        typeof record.name === "string"
        ? {
            type: "tool_call",
            callId: record.callId,
            name: record.name,
            args: record.args,
          }
        : null;
    case "tool_result":
      return typeof record.callId === "string" &&
        typeof record.name === "string" &&
        typeof record.ok === "boolean"
        ? {
            type: "tool_result",
            callId: record.callId,
            name: record.name,
            result: record.result,
            ok: record.ok,
          }
        : null;
    case "plan":
      return Array.isArray(record.entries)
        ? {
            type: "plan",
            entries: (record.entries as Array<Record<string, unknown>>).map(
              (entry) => ({
                content: String(entry.content ?? ""),
                status: String(entry.status ?? "pending"),
                ...(typeof entry.priority === "string"
                  ? { priority: entry.priority }
                  : {}),
              }),
            ),
          }
        : null;
    case "mode":
      return typeof record.modeId === "string"
        ? { type: "mode", modeId: record.modeId }
        : null;
    case "status":
      return typeof record.status === "string" &&
        (record.message === undefined || typeof record.message === "string")
        ? {
            type: "status",
            status: record.status,
            ...(typeof record.message === "string"
              ? { message: record.message }
              : {}),
          }
        : null;
    case "error":
      return typeof record.message === "string"
        ? { type: "error", message: record.message }
        : null;
    default:
      return null;
  }
}
