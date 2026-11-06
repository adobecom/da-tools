/**
 * Shareable-URL navigation for tools embedded in the da.live app.
 *
 * These pages run inside the da.live shell's iframe, whose host is
 * `<ref>--<repo>--<org>.<aem host>` (e.g. main--da-tools--adobecom.preview.da.live).
 * A relative <a> there only navigates the iframe, so the outer da.live address bar
 * never changes and links can't be shared. This rewrites any `<a data-app-path="…">`
 * to the matching da.live app URL and points it at the top window, so clicking a tool
 * updates the shareable URL. Outside that context (local dev, unknown host) each
 * element's original relative href is left untouched.
 *
 * Mapping (see SERVING.md): outer da.live/app/{org}/{repo}/{path}
 *   ↔ inner {ref}--{repo}--{org}.<aem host>/{path}.html   (the app path has no .html).
 * `?ref=<branch>` is preserved so navigating from a non-main preview stays on that branch.
 */
export function enhanceAppLinks(root = document) {
  const parts = location.hostname.split('.')[0].split('--'); // e.g. "main--da-tools--adobecom"
  if (parts.length !== 3) return; // not embedded / unknown host → keep the relative links
  const [ref, repo, org] = parts;
  const suffix = ref === 'main' ? '' : `?ref=${encodeURIComponent(ref)}`;
  root.querySelectorAll('a[data-app-path]').forEach((a) => {
    a.href = `https://da.live/app/${org}/${repo}/${a.dataset.appPath}${suffix}`;
    a.target = '_top';
  });
}
