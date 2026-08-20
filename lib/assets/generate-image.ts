import { getEffectiveApiKey } from '@/lib/api-keys';
import { generateAltText } from '@/lib/assets/alt-text';
import { persistOptimizedAsset, type PersistedAsset } from '@/lib/assets/persist';
import {
  generateWithImageWorker,
  imageWorkerConfig,
  imageWorkerPrompt,
} from '@/lib/assets/image-worker';
import { logGenerationEvent } from '@/lib/usage-costs';

export const NO_IMAGE_PROVIDER_ERROR =
  'No image generation provider configured — add an image worker in Admin → Configuration, or an OpenAI or Google key in Settings → API Keys';

/** The Worker is configured and still could not produce this image. */
export const WORKER_FAILED_ERROR =
  'The image worker could not produce this image, and no OpenAI or Google key is configured as a second attempt';

export type GenerateAspect = '16:9' | '1:1' | '4:5' | '1200x630';

export type GenerateImageInput = {
  projectId: string;
  userId?: string | null;
  prompt: string;
  aspectRatio: GenerateAspect;
};

const OPENAI_SIZE: Record<GenerateAspect, '1536x1024' | '1024x1024' | '1024x1536'> = {
  '16:9': '1536x1024',
  '1:1': '1024x1024',
  '4:5': '1024x1536',
  '1200x630': '1536x1024',
};

const TARGET_SIZE: Partial<Record<GenerateAspect, { width: number; height: number }>> = {
  '1200x630': { width: 1200, height: 630 },
};

async function generateWithOpenAI(apiKey: string, prompt: string, aspect: GenerateAspect) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: OPENAI_SIZE[aspect],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first?.url) {
    const image = await fetch(first.url);
    if (!image.ok) throw new Error('OpenAI image download failed');
    return Buffer.from(await image.arrayBuffer());
  }
  throw new Error('OpenAI image generation returned no image');
}

async function generateWithImagen(apiKey: string, prompt: string, aspect: GenerateAspect) {
  const imagenAspect = aspect === '1200x630' ? '16:9' : aspect === '4:5' ? '3:4' : aspect;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: imagenAspect },
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Imagen failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const data = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string }>;
  };
  const encoded = data.predictions?.[0]?.bytesBase64Encoded;
  if (!encoded) throw new Error('Google Imagen returned no image');
  return Buffer.from(encoded, 'base64');
}

export type GeneratedImage = PersistedAsset & {
  /** Which provider produced it. Only the paid ones are worth metering. */
  provider: 'worker' | 'openai' | 'imagen';
};

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('Image prompt is required');

  // The self-hosted Worker first: it is the operator's own infrastructure, so it
  // costs nothing per image and needs no user key. OpenAI and Imagen stay behind
  // it for deployments that have keys but no Worker.
  const worker = await imageWorkerConfig();
  if (worker) {
    try {
      const buffer = await generateWithImageWorker({
        config: worker,
        description: prompt,
        aspect: input.aspectRatio,
      });
      return await storeGenerated(input, prompt, buffer, 'worker');
    } catch (error) {
      // Not fatal on its own: a key-holding deployment can still answer, and the
      // caller falls back to a stock photo when nothing here can.
      console.warn('[assets] image worker failed:', error instanceof Error ? error.message : error);
    }
  }

  const openai = await getEffectiveApiKey(input.userId, 'openai');
  const google = openai ? null : await getEffectiveApiKey(input.userId, 'gemini');
  if (!openai && !google) {
    throw new Error(worker ? WORKER_FAILED_ERROR : NO_IMAGE_PROVIDER_ERROR);
  }

  // The same subject-level no-text treatment the worker path gets: gpt-image-1
  // and Imagen invent lettering for the same subjects the worker does, so the
  // bare description ("storefront of an artisan pizzeria") produces the exact
  // garbled signage `imageWorkerPrompt`'s module comment measured. The asset
  // row and alt text keep the user's own description.
  const styledPrompt = imageWorkerPrompt(prompt, input.aspectRatio);
  const buffer = openai
    ? await generateWithOpenAI(openai, styledPrompt, input.aspectRatio)
    : await generateWithImagen(google as string, styledPrompt, input.aspectRatio);

  return storeGenerated(input, prompt, buffer, openai ? 'openai' : 'imagen');
}

async function storeGenerated(
  input: GenerateImageInput,
  prompt: string,
  buffer: Buffer,
  provider: GeneratedImage['provider'],
): Promise<GeneratedImage> {
  const altText = await generateAltText({
    userId: input.userId,
    projectId: input.projectId,
    prompt,
  });
  const asset = await persistOptimizedAsset({
    projectId: input.projectId,
    buffer,
    kind: 'generated',
    prompt,
    altText,
    targetSize: TARGET_SIZE[input.aspectRatio],
  });

  if (input.userId) {
    await logGenerationEvent({
      projectId: input.projectId,
      userId: input.userId,
      kind: 'image',
      isUrlClone: false,
    });
  }

  return { ...asset, provider };
}
