const STORAGE_KEY = "kura-theme";

export type Theme = "light" | "dark";

/** localStorage → prefers-color-scheme の順で初期テーマを決めて適用する */
export function initTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  const theme: Theme =
    stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
