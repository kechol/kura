/**
 * Shared interactive prompt helpers for CLI commands (docs: cli-reference.md).
 * Reads a single line of stdin; the TTY gate lets callers degrade to a
 * non-interactive default when stdin/stdout are not terminals.
 */

/** Write the question to stdout and resolve one trimmed line of stdin */
export function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
}

/** y/N confirmation on a TTY. Returns the default when not a TTY */
export async function confirm(prompt: string, nonTtyDefault: boolean): Promise<boolean> {
  if (!isInteractive()) return nonTtyDefault;
  process.stdout.write(`${prompt} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d)));
  });
  return /^y(es)?$/i.test(answer.trim());
}

/** Both stdout and stdin are terminals — the gate for interactive prompts */
export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}
