// Shareable-URL navigation for the "All Tools" back-link, ported from shared/nav.js.
//
// This app runs inside the da.live shell's iframe, whose host is `<ref>--<repo>--<org>.<aem host>`.
// A relative <a> there only navigates the iframe, so the outer da.live address bar never changes.
// When embedded, rewrite the link to the matching da.live app URL and target the top window so the
// shareable URL updates. Outside that context (local dev / unknown host) keep the relative fallback.

export interface AppLink {
  href: string;
  target?: string;
}

export function computeAppHref(appPath: string, fallbackHref: string): AppLink {
  const parts = location.hostname.split('.')[0].split('--'); // e.g. "main--da-tools--adobecom"
  if (parts.length !== 3) return { href: fallbackHref }; // not embedded → keep the relative link
  const [ref, repo, org] = parts;
  const suffix = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
  return { href: `https://da.live/app/${org}/${repo}/${appPath}${suffix}`, target: '_top' };
}
