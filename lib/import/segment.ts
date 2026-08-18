import { wrapUntrustedWebsiteContent } from '../security/untrusted-html.ts';
import type { ImportSection, PageCapture } from './types.ts';

export const MAX_IMPORT_SECTIONS = 12;

function rangeHeight(section: ImportSection) {
  return Math.max(1, section.approximateYRange[1] - section.approximateYRange[0]);
}

function mergePair(left: ImportSection, right: ImportSection): ImportSection {
  return {
    id: left.id,
    label: `${left.label} + ${right.label}`,
    purpose: [left.purpose, right.purpose].filter(Boolean).join('; '),
    contentSummary: [left.contentSummary, right.contentSummary].filter(Boolean).join(' '),
    approximateYRange: [
      Math.min(left.approximateYRange[0], right.approximateYRange[0]),
      Math.max(left.approximateYRange[1], right.approximateYRange[1]),
    ],
  };
}

export function mergeSectionsToCap(sections: ImportSection[], cap = MAX_IMPORT_SECTIONS) {
  const next = sections
    .map((section) => ({
      ...section,
      approximateYRange: [
        Math.min(section.approximateYRange[0], section.approximateYRange[1]),
        Math.max(section.approximateYRange[0], section.approximateYRange[1]),
      ] as [number, number],
    }))
    .sort((a, b) => a.approximateYRange[0] - b.approximateYRange[0]);

  while (next.length > cap) {
    let smallest = 0;
    let smallestHeight = Number.POSITIVE_INFINITY;
    for (let i = 0; i < next.length; i += 1) {
      const height = rangeHeight(next[i]);
      if (height < smallestHeight) {
        smallest = i;
        smallestHeight = height;
      }
    }
    const neighbor = smallest === 0 ? 1 : smallest === next.length - 1 ? smallest - 1 : smallest + 1;
    const leftIndex = Math.min(smallest, neighbor);
    const rightIndex = Math.max(smallest, neighbor);
    const merged = mergePair(next[leftIndex], next[rightIndex]);
    next.splice(leftIndex, 2, merged);
  }
  return next;
}

export type SegmentPageInput = {
  capture: PageCapture;
  complete?: (input: { image: Buffer; text: string }) => Promise<ImportSection[]>;
};

export async function segmentPage(input: SegmentPageInput): Promise<ImportSection[]> {
  const complete = input.complete ?? defaultSegmentComplete;
  const raw = await complete({
    image: input.capture.desktopPng,
    text: input.capture.firecrawlText,
  });
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Segmentation returned no sections');
  }
  return mergeSectionsToCap(raw, MAX_IMPORT_SECTIONS);
}

async function defaultSegmentComplete(input: { image: Buffer; text: string }): Promise<ImportSection[]> {
  const { generateObject } = await import('ai');
  const { z } = await import('zod');
  const { getProviderForModel } = await import('../ai/provider-manager.ts');
  const { appConfig } = await import('../../config/app.config.ts');

  const schema = z.object({
    sections: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          purpose: z.string().min(1),
          contentSummary: z.string().min(1),
          approximateYRange: z.tuple([z.number(), z.number()]),
        }),
      )
      .min(1),
  });

  const { client, actualModel } = getProviderForModel(appConfig.ai.defaultModel);
  const result = await generateObject({
    model: client(actualModel),
    schema,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Segment this landing page into ordered visual sections (hero, nav, features, footer, …).
Return 1–12 sections. Each needs id (slug), label, purpose, contentSummary, approximateYRange [yStart, yEnd] in CSS pixels on the desktop screenshot.

PAGE TEXT:
${wrapUntrustedWebsiteContent(input.text, 6000)}`,
          },
          { type: 'image', image: input.image },
        ],
      },
    ],
  });
  return result.object.sections;
}
