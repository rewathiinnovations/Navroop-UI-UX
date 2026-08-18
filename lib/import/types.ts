import type { FirecrawlScrapeResult } from './firecrawl.ts';
import type { ImportMode } from './mode.ts';

export type DesignTokens = {
  fontFamily: string;
  fontSizes: string[];
  colors: string[];
  radii: string[];
  spacingRhythm: string[];
};

export type CapturedImage = {
  url: string;
  width: number;
  height: number;
  alt?: string;
};

export type PageCapture = {
  sourceUrl: string;
  desktopPng: Buffer;
  mobilePng: Buffer;
  tokens: DesignTokens;
  images: CapturedImage[];
  firecrawlText: string;
  /** Typed Firecrawl outcome. Absent on older fixtures — treat as ok + firecrawlText. */
  firecrawl?: FirecrawlScrapeResult;
  capturedAt: Date;
};

export type ImportSection = {
  id: string;
  label: string;
  purpose: string;
  contentSummary: string;
  approximateYRange: [number, number];
};

export type RehostedAsset = {
  url: string;
  altText: string;
  width: number;
  height: number;
  sourceUrl?: string;
};

export type RehostResult = {
  assets: RehostedAsset[];
  warnings: string[];
};

export type GenerateSectionsResult = {
  filesXml: string;
  inputTokens: number;
  warnings?: string[];
};

export type UrlImportResult = {
  filesXml: string;
  sections: ImportSection[];
  tokens: DesignTokens;
  assets: RehostedAsset[];
  warnings: string[];
  usedFallback: boolean;
  inputTokens: number;
  sourceUrl: string;
  mode: ImportMode;
};
