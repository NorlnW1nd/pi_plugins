import * as fs from "node:fs";
import * as path from "node:path";

export function relativeScope(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
	if (!normalized || normalized === "." || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..") || /[*?\[\]{}\x00-\x1f]/.test(normalized)) {
		throw new Error(`Scope must be a concrete repository-relative file or directory: ${value}`);
	}
	if (normalized.split("/").some(part => part === ".git" || part === ".pi") || normalized === "AGENTS.md" || normalized === "AGENTS.override.md") {
		throw new Error(`Workflow metadata and repository instructions cannot be Worker scope: ${value}`);
	}
	return normalized;
}

/** Resolve existing ancestors as well as new paths, so a symlink cannot escape scope. */
export function canonicalPath(file: string): string {
	let current = path.resolve(file);
	const missing: string[] = [];
	while (!fs.existsSync(current)) {
		// A dangling symlink must not be treated as a new ordinary file.
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Dangling symlink: ${current}`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		missing.unshift(path.basename(current));
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`Cannot resolve path: ${file}`);
		current = parent;
	}
	return path.join(fs.realpathSync(current), ...missing);
}

export function assertWorkerPath(root: string, file: string, scope: readonly string[]): void {
	const realRoot = fs.realpathSync(root);
	const lexical = path.resolve(root, file);
	const target = canonicalPath(lexical);
	if (fs.existsSync(target) && fs.statSync(target).isFile() && fs.statSync(target).nlink > 1) throw new Error(`Refusing to modify a hard-linked file: ${file}`);
	const relative = path.relative(realRoot, target).replace(/\\/g, "/");
	relativeScope(relative);
	const lexicalRelative = path.relative(path.resolve(root), lexical).replace(/\\/g, "/");
	relativeScope(lexicalRelative);
	const contained = (candidate: string, allowed: string) => candidate === allowed || candidate.startsWith(`${allowed}/`);
	if (!scope.some(entry => {
		const normalized = relativeScope(entry);
		const allowedReal = path.relative(realRoot, canonicalPath(path.join(root, normalized))).replace(/\\/g, "/");
		relativeScope(allowedReal);
		return contained(lexicalRelative, normalized) && contained(relative, allowedReal);
	})) throw new Error(`Write outside task scope: ${file}`);
}

/** Managed metadata must be ordinary paths beneath this repository, not symlink aliases. */
export function assertMetadataPath(root: string, relative: string): void {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Metadata path escapes repository: ${relative}`);
  let current = path.resolve(root);
  for (const component of rel.split(path.sep)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Managed metadata cannot use symlinks: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
