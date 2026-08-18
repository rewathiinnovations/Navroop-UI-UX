export const TEMPLATE_CATEGORIES = [
  'business',
  'portfolio',
  'restaurant',
  'clinic',
  'realestate',
  'ecommerce',
  'event',
  'education',
  'saas',
  'personal',
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  business: 'Business',
  portfolio: 'Portfolio',
  restaurant: 'Restaurant',
  clinic: 'Clinic',
  realestate: 'Real estate',
  ecommerce: 'Ecommerce',
  event: 'Event',
  education: 'Education',
  saas: 'SaaS',
  personal: 'Personal',
};

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}
