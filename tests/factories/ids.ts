export function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}
