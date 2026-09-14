export const INIT_PROMPT = `Initialize reusable project understanding. Read .pi/PROJECT.md, existing repository instructions, README, relevant build/CI manifests and representative source files. Establish architecture and module responsibilities, conventions, setup, focused verification commands, and pitfalls with file references. Keep unsupported conclusions explicitly unknown. Save concise guidance in the user's language with pi_project_context. This is read-only repository research, not an implementation task. Do not run shell commands or change source files.

Additional user instructions for this initialization:
$ARGUMENTS`;

export function renderInitPrompt(args: string): string {
  // A callback keeps dollar signs literal and avoids recursively expanding user text.
  return INIT_PROMPT.replaceAll("$ARGUMENTS", () => args);
}
