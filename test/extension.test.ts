import { describe, expect, it } from "vitest";
import initExtension from "../extensions/init.ts";
import { findRepositoryRoot } from "../src/discovery.ts";

function registration() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  initExtension({ registerCommand: (name: string, options: any) => commands.set(name, options), registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, callback: any) => events.set(name, callback), appendEntry() {}, sendMessage() {} } as any);
  return { commands, tools, events };
}
describe("Pi extension", () => {
  it("registers the complete user workflow and actual dispatch tools", () => {
    const { commands, tools, events } = registration();
    expect([...commands.keys()]).toEqual(["init", "plan", "apply", "verify", "status", "archive", "workflow-exit"]);
    expect(commands.get("init").description).toMatch(/Sergeant and Worker/);
    expect(tools.has("pi_delegate")).toBe(true);
    expect(events.has("before_agent_start")).toBe(true);
  });
  it("does not impose workflow tool restrictions before initialization", () => {
    expect(registration().events.get("tool_call")({ toolName: "bash" })).toBeUndefined();
  });
  it("blocks writes and unrelated tools in a restored planning session", async () => {
    const { events } = registration();
    const cwd = process.cwd();
    await events.get("session_start")({}, { cwd, sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-workflow-mode", data: { root: findRepositoryRoot(cwd), stage: "plan", id: "test" } }] } });
    expect(events.get("tool_call")({ toolName: "bash" })).toMatchObject({ block: true });
    expect(events.get("tool_call")({ toolName: "write" })).toMatchObject({ block: true });
    expect(events.get("tool_call")({ toolName: "some_other_agent" })).toMatchObject({ block: true });
    expect(events.get("tool_call")({ toolName: "read" })).toBeUndefined();
  });
});
