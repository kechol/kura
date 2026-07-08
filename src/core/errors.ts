/** Invalid arguments or input (exit 2) */
export class UsageError extends Error {}

/** Target not found (exit 3) */
export class NotFoundError extends Error {}

/** Conflict such as a unique-constraint violation (exit 1) */
export class ConflictError extends Error {}

/** LLM provider unavailable (exit 4) */
export class LLMUnavailableError extends Error {}
