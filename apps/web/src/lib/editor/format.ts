/** Uppercases the first character of `word`, leaving the rest untouched. */
export function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}
