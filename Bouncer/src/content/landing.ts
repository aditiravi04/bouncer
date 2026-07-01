// Content script injected on the Bouncer share landing page
// (bouncer.imbue.com/import). Its only job is to be *silent and fast*: when
// Bouncer is installed this runs, hands the shared filter code to the extension
// via chrome.storage, and redirects to x.com — where the x.com content script
// shows the "Apply this filter?" prompt. If Bouncer is NOT installed this never
// runs, and the page's own script redirects to the Web Store instead.

import { setPendingImport } from '../shared/storage';

// localStorage key the page writes before the Web-Store redirect (survives it
// because it's per-origin); we read it back on the post-install open.
const PENDING_KEY = 'bouncerPendingImport';

function readStashedCode(): string {
  try { return localStorage.getItem(PENDING_KEY) || ''; } catch { return ''; }
}

function clearStashedCode(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* storage may be blocked */ }
}

async function main(): Promise<void> {
  // Prefer the code in the URL fragment (direct click); fall back to the
  // localStorage stash left before the Web-Store redirect (post-install).
  let code = location.hash.replace(/^#/, '');
  if (!code) code = readStashedCode();
  clearStashedCode();

  // Hand the code to the extension so the x.com content script can pick it up.
  // Storage is the channel (not the URL) so Twitter's router can't strip it.
  if (code) await setPendingImport(code);

  // Installed users always end up on X; the modal shows there.
  window.location.href = 'https://x.com';
}

main().catch(err => console.error('[Bouncer] landing redirect failed:', err));
