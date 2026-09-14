import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import initExtension from "../extensions/init.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function initialize(args: string, confirmed = true) {
  const root = await fs.mkdtemp("/tmp/pi-init-arguments-test-");
  roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const prompts: string[] = [];
  const errors: string[] = [];
  const api: Partial<ExtensionAPI> = {
    registerCommand(name, options) { if (name === "init") handler = options.handler; },
    registerTool() {}, on() {}, appendEntry() {}, sendMessage() {}, setThinkingLevel() {},
    setModel: async () => true,
    sendUserMessage(content) {
      if (typeof content !== "string") throw new Error("Expected a text prompt");
      prompts.push(content);
    },
  };
  initExtension(api as ExtensionAPI);
  const ctx = {
    cwd: root, hasUI: true, isIdle: () => true, scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake", name: "Test model", reasoning: false }] },
    ui: {
      select: async (_title: string, options: string[]) => options[0],
      confirm: async () => confirmed,
      notify(message: string, type?: string) { if (type === "error") errors.push(message); },
    },
  } as unknown as ExtensionCommandContext;
  expect(handler).toBeDefined();
  await handler!(args, ctx);
  expect(errors).toEqual([]);
  return { root, prompts };
}

describe("/init prompt arguments", () => {
  it.each([
    "请用中文说明项目，重点分析插件和测试流程",
    '  保留  内部空格、"引号"和换行\n第二行\t包括 $&、$$、$`、$\'、$1、$ARGUMENTS 和 `代码`  ',
    "--quick 请将这段完整文本当作用户指令",
  ])("passes the entire received instruction literally: %s", async args => {
    const { prompts } = await initialize(args);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Read .pi/PROJECT.md");
    expect(prompts[0]).toContain("Additional user instructions for this initialization:\n");
    expect(prompts[0].endsWith(args)).toBe(true);
  });

  it("keeps no-argument initialization and removes the placeholder", async () => {
    const { root, prompts } = await initialize("");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Initialize reusable project understanding.");
    expect(prompts[0]).not.toContain("$ARGUMENTS");
    expect(await fs.readFile(path.join(root, ".pi/workflow.json"), "utf8")).toContain('"version": 1');
  });

  it("preserves standalone --quick without sending a research prompt", async () => {
    const { root, prompts } = await initialize("  --quick  ");
    expect(prompts).toEqual([]);
    expect(await fs.readFile(path.join(root, ".pi/PROJECT.md"), "utf8")).toContain("Repository inventory");
  });

  it("does not dispatch instructions when initialization is cancelled", async () => {
    const { root, prompts } = await initialize("请分析测试", false);
    expect(prompts).toEqual([]);
    await expect(fs.stat(path.join(root, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
