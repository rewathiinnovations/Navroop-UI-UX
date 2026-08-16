export type DefaultSkill = {
  name: string;
  description: string;
  content: string;
};

/** Trigger-focused descriptions (matching reads these). Content is the injected playbook. */
export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    name: 'Landing page structure',
    description:
      'When building a marketing, landing, pricing, homepage, or conversion-focused page with a hero or CTA',
    content:
      'Hero with one clear CTA. Put social proof above the fold. Write benefit-led (not feature-led) copy. One primary conversion action per page. Include an FAQ section for AEO.',
  },
  {
    name: 'Form UX',
    description: 'When adding or editing a form, fields, validation, or submit flow',
    content:
      'Inline validation on blur, not submit. Explicit labels — never placeholder-as-label. Clear error text below each field. Disabled + spinner submit state. Success confirmation after submit.',
  },
  {
    name: 'Data table UX',
    description: 'When building a data table, sortable rows, pagination, or grid of records',
    content:
      'Sortable headers. Empty state with a next action. Loading skeletons. Pagination past 25 rows. Contain horizontal scroll on mobile.',
  },
  {
    name: 'Dashboard layout',
    description: 'When building a dashboard with metrics, widgets, filters, or summary cards',
    content:
      'Summary metrics row first. Filters directly above content. Consistent card treatment. Meaningful empty and error states per widget.',
  },
];
