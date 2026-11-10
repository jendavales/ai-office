/**
 * Libraries of the conversation UI, loaded straight from node_modules (no build step, like the rest of the renderer):
 * Preact + htm in one standalone module, marked for markdown and DOMPurify to keep Claude's HTML harmless.
 */
export { html, render, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../../node_modules/htm/preact/standalone.module.js';
import { marked } from '../../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../../node_modules/dompurify/dist/purify.es.mjs';

// like Claude desktop: a single newline inside a paragraph is not a line break
marked.setOptions({ gfm: true, breaks: false });

/** Claude's markdown → sanitized HTML. No images: the CSP blocks remote ones anyway, local paths would only break. */
export function markdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? '')), { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'img'] });
}

/** Message of a failed IPC call without Electron's "Error invoking remote method" wrapping. */
export const ipcError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
