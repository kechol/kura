const STORAGE_KEY = "kura-last-doc";

/** The document the user was last reading, so a fresh visit lands back where they left off */
export function rememberDoc(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function forgetDoc(key: string): void {
  if (localStorage.getItem(STORAGE_KEY) === key) localStorage.removeItem(STORAGE_KEY);
}

export function lastDoc(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * Rewrite the URL to the last-read document before the first render, so opening kura
 * resumes reading instead of landing on an empty home. Only the bare entry point "/"
 * redirects — the home screen stays reachable from the logo, the nav and Ctrl+H, and a
 * deleted document clears the memory on its 404 (DocDetail).
 */
export function bootRedirect(): void {
  const key = lastDoc();
  if (key === null || window.location.pathname !== "/") return;
  window.history.replaceState(null, "", `/docs/${encodeURIComponent(key)}`);
}
