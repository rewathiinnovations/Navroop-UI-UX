export type ElementScope = {
  tagName: string;
  text: string;
  selectorPath: string;
};

export type InstructionMode = 'text-edit' | 'instruction';

/**
 * Packages a preview-element selection into one follow-up prompt.
 * Both popover modes call this — no other backend formatting.
 */
export function formatElementScopedInstruction(
  payload: ElementScope,
  userInstruction: string,
  mode: InstructionMode = 'instruction',
): string {
  const tagName = payload.tagName || 'element';
  const text = payload.text || '';
  const selectorPath = payload.selectorPath || 'body';
  const instruction = userInstruction.trim();

  if (mode === 'text-edit') {
    return `Change the text "${text}" (element: ${tagName}, approximate selector: ${selectorPath}) to: "${instruction}"`;
  }

  return `For the ${tagName} element containing "${text}" (approximate selector: ${selectorPath}): ${instruction}`;
}
