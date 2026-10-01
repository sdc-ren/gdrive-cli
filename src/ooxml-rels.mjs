// Đọc file .rels của OOXML: Id → {target, type}. Dùng chung cho pptx (thứ tự slide, notes)
// và có thể cho xlsx về sau.

import { forEachElement } from './xml.mjs';

export function parseRels(xml) {
  const map = new Map();
  forEachElement(xml ?? '', 'Relationship', ({ attrs }) => {
    if (attrs.Id) map.set(attrs.Id, { target: attrs.Target ?? '', type: attrs.Type ?? '' });
  });
  return map;
}

/** `../notesSlides/x.xml` từ `ppt/slides/` → `ppt/notesSlides/x.xml`; `/ppt/a.xml` → `ppt/a.xml`. */
export function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
