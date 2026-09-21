/**
 * Literal hierarchy matching for slash-separated paths.
 *
 * `LIKE prefix || '/%'` treats `%` and `_` in user data as wildcards. This
 * predicate instead tests the exact value or a literal `prefix/` at byte 1.
 * Column expressions are internal constants, never user input.
 */
export function hierarchyPredicate(column: string, caseInsensitive = false): string {
  const value = caseInsensitive ? `lower(${column})` : column;
  const parameter = caseInsensitive ? "lower(?)" : "?";
  return `(${value} = ${parameter} OR instr(${value}, ${parameter} || '/') = 1)`;
}

export function hierarchyParameters(value: string): [string, string] {
  return [value, value];
}
