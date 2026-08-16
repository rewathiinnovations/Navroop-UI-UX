import { checkContentStructure } from './checks/content-structure';
import { checkIndexing } from './checks/indexing';
import { checkMetadata } from './checks/metadata';
import { checkOpenGraph } from './checks/open-graph';
import { checkPageBasics } from './checks/page-basics';
import { checkRobots } from './checks/robots';
import { checkSitemap } from './checks/sitemap';
import { checkStructuredData } from './checks/structured-data';
import type { SeoFinding, SeoScanInput } from './types';

export function runSeoChecks(input: SeoScanInput): SeoFinding[] {
  return [
    ...checkPageBasics(input),
    ...checkMetadata(input),
    ...checkOpenGraph(input),
    ...checkStructuredData(input),
    ...checkRobots(input),
    ...checkSitemap(input),
    ...checkIndexing(input),
    ...checkContentStructure(input),
  ];
}
