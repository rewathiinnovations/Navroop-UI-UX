export const IMPORT_PROGRESS = {
  capturing: 'Capturing page…',
  extracting: 'Extracting design…',
} as const;

export function buildingSectionProgress(current: number, total: number) {
  return `Building section ${current} of ${total}…`;
}

export function composingProgress() {
  return 'Composing layout…';
}
