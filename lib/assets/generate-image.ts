import { getEffectiveApiKey } from '@/lib/api-keys';
import { fallbackAltText } from '@/lib/assets/keys';
import { persistOptimizedAsset } from '@/lib/assets/persist';
import { logGenerationEvent } from '@/lib/usage-costs';

export const NO_IMAGE_PROVIDER_ERROR =
  'No image generation provider configured — add an OpenAI or Google key in Settings → API Keys';

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

async function generateAltText(userId: string | null | undefined, prompt: string) {
  const fallback = fallbackAltText(prompt);
  const openai = await getEffectiveApiKey(userId, 'openai');
  if (openai) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openai}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 60,
          messages: [
            {
              role: 'system',
              content: 'Write a concise image alt text (max 12 words). No quotes.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content?.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    } catch {
      /* fall through */
    }
  }
  const google = await getEffectiveApiKey(userId, 'gemini');
  if (google) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(google)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Write concise image alt text (max 12 words) for: ${prompt}` }] }],
          }),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

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

export async function generateImage(input: GenerateImageInput) {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('Image prompt is required');

  const openai = await getEffectiveApiKey(input.userId, 'openai');
  const google = openai ? null : await getEffectiveApiKey(input.userId, 'gemini');
  if (!openai && !google) {
    throw new Error(NO_IMAGE_PROVIDER_ERROR);
  }

  const buffer = openai
    ? await generateWithOpenAI(openai, prompt, input.aspectRatio)
    : await generateWithImagen(google as string, prompt, input.aspectRatio);

  const altText = await generateAltText(input.userId, prompt);
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

  return asset;
}
