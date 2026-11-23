import type { ProductTypeConfig } from './types';

export type SiteId = 'express' | 'express-print';

export interface SiteConfig {
  id: SiteId;
  label: string;
  org: string;
  repo: string;
  daRoot: string;
  defaultConfigSheet: string;
  defaultManagerRoot: string;
  productionOrigin: string;
}

export const SITES: Record<SiteId, SiteConfig> = {
  express: {
    id: 'express',
    label: 'Adobe Express',
    org: 'adobecom',
    repo: 'da-express-milo',
    daRoot: '/adobecom/da-express-milo',
    defaultConfigSheet: '/adobecom/da-express-milo/doc-generator-presets',
    defaultManagerRoot: '/adobecom/da-express-milo/express/print',
    productionOrigin: 'https://www.adobe.com',
  },
  'express-print': {
    id: 'express-print',
    label: 'Print',
    org: 'adobecom',
    repo: 'express-print',
    daRoot: '/adobecom/express-print',
    defaultConfigSheet: '/adobecom/express-print/drafts/doc-generator-presets',
    defaultManagerRoot: '/adobecom/express-print/drafts/print',
    productionOrigin: 'https://print.adobe.com',
  },
};

export const SITE_OPTIONS: SiteConfig[] = [SITES.express, SITES['express-print']];

export function isPathWithinSite(path: string, site: SiteConfig): boolean {
  const normalized = path.trim().replace(/\.(?:html|json)$/, '').replace(/\/$/, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return false;
  return normalized === site.daRoot || normalized.startsWith(`${site.daRoot}/`);
}

export function isConfigWithinSite(config: ProductTypeConfig, site: SiteConfig): boolean {
  return isPathWithinSite(config.templatePath, site) && isPathWithinSite(config.outputDir, site);
}

export function findSite(org: string, repo: string): SiteConfig | undefined {
  return SITE_OPTIONS.find((site) => site.org === org && site.repo === repo);
}
