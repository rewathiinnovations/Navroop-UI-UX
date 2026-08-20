/**
 * F-091 — what an image attached in the chat composer contributes to the prompt.
 *
 * WHAT AN ATTACHMENT IS HERE
 * A pasted, dropped or picked image goes through the ordinary asset upload
 * (`uploadProjectAsset`): the 10 MB body ceiling, the magic-byte sniff, the
 * 30-per-hour per-user limiter, sharp's 32 MP decode bound and the workspace
 * storage charge all apply, because it *is* an ordinary upload. It becomes a
 * `ProjectAsset` with `kind: 'uploaded'`, which is already listed in every later
 * generation's asset manifest. Attaching therefore does not need a second
 * pipeline; it needs a way to say "use this one, for this request".
 *
 * WHAT THE MODEL DOES NOT GET
 * It does not get the picture. DeepSeek is the only configured provider
 * (`lib/ai/providers.ts`) and its chat models take text only, so nothing here
 * pretends the model can see a screenshot. This block tells it the image exists
 * at a URL it may reference; the description it goes by is the asset's alt text,
 * which the user can correct in the Images tab.
 *
 * WHY THE SHAPE IS THIS NARROW
 * An attachment carries exactly one piece of attacker-controlled text — the
 * filename, which becomes the asset's alt text. That value already has a fenced
 * path into the prompt (`formatAssetManifest` flattens it through
 * `sanitizeUntrustedLine`). Giving it a second, unfenced path through the user's
 * own message would undo that, so `PromptAttachment` has no field for it: this
 * block is built only from the storage URL and the decoded dimensions, both of
 * which this system produced.
 */

/** Everything the composer may quote about an attachment. Deliberately not the filename. */
export type PromptAttachment = {
  url: string;
  width: number;
  height: number;
};

/**
 * The image types the upload actually accepts, so the file dialog cannot offer a
 * choice the server will refuse. Mirrors `sniffImageType` in `./optimize.ts`,
 * which is the authority — that module imports sharp, so it cannot be reached
 * from a `'use client'` composer.
 */
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function attachmentPromptBlock(attachments: PromptAttachment[]) {
  if (attachments.length === 0) return '';
  const lines = attachments.map(
    (attachment) => `- ${attachment.url} (${attachment.width}x${attachment.height})`,
  );
  return [
    '',
    '',
    'ATTACHED IMAGES — already uploaded to this project. Use these exact URLs where they fit; do not request new images for them:',
    ...lines,
  ].join('\n');
}
