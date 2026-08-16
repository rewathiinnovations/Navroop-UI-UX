export function normalizeMemoryContent(content: string) {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isDuplicateMemory(content: string, activeContents: string[]) {
  const needle = normalizeMemoryContent(content);
  if (!needle) return false;
  return activeContents.some((existing) => normalizeMemoryContent(existing) === needle);
}
