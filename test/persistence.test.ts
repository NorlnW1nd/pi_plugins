import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistenceError, persistArtifacts } from "../src/persistence.ts";

const temporaryDirectories: string[] = [];

async function makeTemp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-init-persist-test-"));
	temporaryDirectories.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("artifact persistence", () => {
	it("creates all staged artifacts", async () => {
		const root = await makeTemp();
		const first = path.join(root, "AGENTS.md");
		const second = path.join(root, ".pi", "SERGEANT.md");
		await persistArtifacts([
			{ path: first, content: "agents", original: null },
			{ path: second, content: "policy", original: null },
		]);
		expect(await fs.readFile(first, "utf8")).toBe("agents");
		expect(await fs.readFile(second, "utf8")).toBe("policy");
	});

	it("detects concurrent edits before writing anything", async () => {
		const root = await makeTemp();
		const first = path.join(root, "AGENTS.md");
		const second = path.join(root, "new.md");
		await fs.writeFile(first, "changed");
		await expect(
			persistArtifacts([
				{ path: first, content: "replacement", original: "old" },
				{ path: second, content: "new", original: null },
			]),
		).rejects.toBeInstanceOf(PersistenceError);
		expect(await fs.readFile(first, "utf8")).toBe("changed");
		await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
