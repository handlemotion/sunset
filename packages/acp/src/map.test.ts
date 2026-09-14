import { describe, expect, it } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@sunset/domain";

import { asAgentEvent, mapSessionUpdate } from "./map.js";

function update(value: unknown): acp.SessionUpdate {
  return value as acp.SessionUpdate;
}

describe("mapSessionUpdate", () => {
  it("maps usage_update to a usage event", () => {
    expect(
      mapSessionUpdate(
        update({ sessionUpdate: "usage_update", used: 1200, size: 200_000 }),
      ),
    ).toEqual([{ type: "usage", used: 1200, size: 200_000 }]);
  });

  it("maps session_info_update to session_title, preferring the protocol title", () => {
    expect(
      mapSessionUpdate(
        update({ sessionUpdate: "session_info_update", title: "Fix bug" }),
      ),
    ).toEqual([{ type: "session_title", title: "Fix bug" }]);
    expect(
      mapSessionUpdate(
        update({
          sessionUpdate: "session_info_update",
          _meta: { title: "Meta title" },
        }),
      ),
    ).toEqual([{ type: "session_title", title: "Meta title" }]);
    expect(
      mapSessionUpdate(
        update({
          sessionUpdate: "session_info_update",
          title: "Protocol title",
          _meta: { title: "Meta title" },
        }),
      ),
    ).toEqual([{ type: "session_title", title: "Protocol title" }]);
  });

  it("ignores session_info_update without a string title", () => {
    for (const value of [
      { sessionUpdate: "session_info_update" },
      { sessionUpdate: "session_info_update", title: null },
      { sessionUpdate: "session_info_update", title: 42 },
      { sessionUpdate: "session_info_update", _meta: { title: null } },
    ]) {
      expect(mapSessionUpdate(update(value))).toEqual([]);
    }
  });

  it("maps available_commands_update to commands", () => {
    expect(
      mapSessionUpdate(
        update({
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "create_plan", description: "Create a plan" },
            { name: "research" },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "commands",
        commands: [
          { name: "create_plan", description: "Create a plan" },
          { name: "research" },
        ],
      },
    ]);
  });

  it("keeps ignoring non-event updates", () => {
    for (const sessionUpdate of [
      "config_option_update",
      "compaction_update",
      "compaction_summary_chunk",
      "plan_update",
      "plan_removed",
      "user_message_chunk",
    ]) {
      expect(mapSessionUpdate(update({ sessionUpdate }))).toEqual([]);
    }
  });
});

describe("asAgentEvent", () => {
  it("round-trips the new variants", () => {
    const events: AgentEvent[] = [
      { type: "usage", used: 5, size: 10 },
      { type: "session_title", title: "hello" },
      {
        type: "commands",
        commands: [{ name: "a", description: "A" }, { name: "b" }],
      },
    ];
    for (const event of events) {
      expect(asAgentEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

  it("returns null for malformed values", () => {
    for (const value of [
      { type: "usage", used: "5", size: 10 },
      { type: "usage", used: 5 },
      { type: "session_title" },
      { type: "session_title", title: 7 },
      { type: "commands", commands: "nope" },
      { type: "commands", commands: [{ name: 1 }] },
      { type: "commands", commands: [{ name: "a", description: 3 }] },
      { type: "commands", commands: ["x"] },
    ]) {
      expect(asAgentEvent(value)).toBeNull();
    }
  });
});
