import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Artifact {
	path: string;
	content: string;
	original: string | null;
}

export class PersistenceError extends Error {
	constructor(
		message: string,
		readonly changedPaths: readonly string[],
		readonly rollbackFailures: readonly string[],
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PersistenceError";
	}
}

async function readCurrent(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function atomicReplace(filePath: string, content: string): Promise<void> {
	const temporary = `${filePath}.pi-init-restore-${randomUUID()}`;
	await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await fs.rename(temporary, filePath);
}

export async function persistArtifacts(artifacts: readonly Artifact[]): Promise<void> {
	const unique = new Set(artifacts.map((artifact) => artifact.path));
	if (unique.size !== artifacts.length) throw new Error("Refusing to persist duplicate artifact paths");

	for (const artifact of artifacts) {
		const current = await readCurrent(artifact.path);
		if (current !== artifact.original) {
			throw new PersistenceError(`Refusing to overwrite concurrently changed file: ${artifact.path}`, [], []);
		}
	}

	const staged = new Map<string, string>();
	const changed: string[] = [];
	try {
		for (const artifact of artifacts) {
			await fs.mkdir(path.dirname(artifact.path), { recursive: true });
			const temporary = `${artifact.path}.pi-init-stage-${randomUUID()}`;
			let mode: number | undefined;
			try {
				mode = (await fs.stat(artifact.path)).mode & 0o777;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await fs.writeFile(temporary, artifact.content, { encoding: "utf8", flag: "wx", mode });
			staged.set(artifact.path, temporary);
		}

		for (const artifact of artifacts) {
			await fs.rename(staged.get(artifact.path)!, artifact.path);
			staged.delete(artifact.path);
			changed.push(artifact.path);
		}
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const artifact of [...artifacts].reverse()) {
			if (!changed.includes(artifact.path)) continue;
			try {
				if (artifact.original === null) await fs.unlink(artifact.path);
				else await atomicReplace(artifact.path, artifact.original);
			} catch {
				rollbackFailures.push(artifact.path);
			}
		}
		for (const temporary of staged.values()) {
			try {
				await fs.unlink(temporary);
			} catch {
				// Best-effort cleanup; the primary error remains more useful.
			}
		}
		throw new PersistenceError(
			`Initialization persistence failed${rollbackFailures.length > 0 ? "; rollback was incomplete" : "; prior files were restored"}`,
			changed,
			rollbackFailures,
			{ cause: error },
		);
	}
}
