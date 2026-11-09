/**
 * Accepts `/org/repo/folder`, `org/repo/folder`, or a da.live browse/edit URL and returns
 * `/org/repo/folder` (no trailing slash). Throws when the path doesn't name a folder inside a repo.
 */
export function normalizeRoot(input: string): string {
  let s = input.trim().replace(/^https?:\/\/da\.live\/(?:edit)?#/, '');
  s = s.replace(/[?#].*$/, '').replace(/\.html$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 3) {
    throw new Error('Enter a folder inside a repo, e.g. /adobecom/da-express-milo/drafts/maxn/document-generator');
  }
  return `/${parts.join('/')}`;
}

export function isDraftsRoot(root: string): boolean {
  return root.split('/').filter(Boolean)[2] === 'drafts';
}

export function folderName(root: string): string {
  return root.split('/').filter(Boolean).pop() ?? '';
}
