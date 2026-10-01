import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pptxToText, readPptx } from '../src/ooxml-pptx.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const slide = (title, ...body) => `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
  <p:sp><p:txBody>
    <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
  </p:txBody></p:sp>
  <p:sp><p:txBody>
    ${body.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('')}
  </p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

const notes = (text) => `<p:notes xmlns:a="a"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:notes>`;

function pptx(extra = []) {
  return makeZip([
    { name: 'ppt/slides/slide1.xml', data: slide('Slide một', 'điểm A', 'điểm B') },
    { name: 'ppt/slides/slide2.xml', data: slide('Slide hai', 'nội dung 2'), dataDescriptor: true },
    { name: 'ppt/slides/slide10.xml', data: slide('Slide mười', 'nội dung 10'), localExtra: 20 },
    ...extra,
  ]);
}

// Sort chuỗi sẽ cho slide10 đứng trước slide2 — đây là bẫy kinh điển.
test('slide sắp xếp theo SỐ, không theo chuỗi', () => {
  const { slides } = readPptx(pptx());
  assert.deepEqual(
    slides.map((s) => s.title),
    ['Slide một', 'Slide hai', 'Slide mười'],
  );
  assert.deepEqual(
    slides.map((s) => s.number),
    [1, 2, 3],
  );
});

test('mỗi slide giữ ranh giới riêng, dòng đầu là tiêu đề suy đoán', () => {
  const { slides } = readPptx(pptx());
  assert.equal(slides[0].title, 'Slide một');
  assert.deepEqual(slides[0].body, ['điểm A', 'điểm B']);
  assert.deepEqual(slides[1].body, ['nội dung 2']);
});

test('mặc định KHÔNG lấy notes; bật includeNotes mới có', () => {
  const extra = [
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes('ghi chú cho slide 1') },
    { name: 'ppt/notesSlides/notesSlide10.xml', data: notes('ghi chú cho slide 10') },
  ];
  assert.equal(readPptx(pptx(extra)).slides[0].notes, null);

  const withNotes = readPptx(pptx(extra), { includeNotes: true });
  assert.equal(withNotes.slides[0].notes, 'ghi chú cho slide 1');
  assert.equal(withNotes.slides[1].notes, null, 'slide 2 không có notes');
  assert.equal(withNotes.slides[2].notes, 'ghi chú cho slide 10', 'notes khớp theo SỐ part');
});

test('<a:br/> thành xuống dòng trong cùng một paragraph', () => {
  const zip = makeZip([
    {
      name: 'ppt/slides/slide1.xml',
      data: `<p:sld><a:p><a:r><a:t>dòng 1</a:t></a:r><a:br/><a:r><a:t>dòng 2</a:t></a:r></a:p></p:sld>`,
    },
  ]);
  assert.equal(readPptx(zip).slides[0].title, 'dòng 1\ndòng 2');
});

test('bỏ nhánh mc:Fallback', () => {
  const zip = makeZip([
    {
      name: 'ppt/slides/slide1.xml',
      data: `<p:sld><mc:AlternateContent>
        <mc:Choice><a:p><a:r><a:t>hộp chữ</a:t></a:r></a:p></mc:Choice>
        <mc:Fallback><a:p><a:r><a:t>hộp chữ</a:t></a:r></a:p></mc:Fallback>
      </mc:AlternateContent></p:sld>`,
    },
  ]);
  const { slides } = readPptx(zip);
  assert.equal(slides[0].title, 'hộp chữ');
  assert.equal(slides[0].body.length, 0);
});

test('paragraph rỗng bị bỏ, không sinh dòng trắng', () => {
  const zip = makeZip([
    { name: 'ppt/slides/slide1.xml', data: `<p:sld><a:p/><a:p><a:r><a:t>chỉ một</a:t></a:r></a:p><a:p><a:r><a:t>  </a:t></a:r></a:p></p:sld>` },
  ]);
  const { slides } = readPptx(zip);
  assert.equal(slides[0].title, 'chỉ một');
  assert.deepEqual(slides[0].body, []);
});

test('cảnh báo media và object nhúng', () => {
  const { warnings } = readPptx(
    pptx([
      { name: 'ppt/media/image1.png', data: Buffer.from([1, 2, 3]), store: true },
      { name: 'ppt/embeddings/Book1.xlsx', data: Buffer.from([4, 5]), store: true },
    ]),
  );
  assert.ok(warnings.some((w) => /media|hình/.test(w)));
  assert.ok(warnings.some((w) => /nhúng/.test(w)));
});

test('không có slide nào → lỗi nói rõ', () => {
  assert.throws(() => readPptx(makeZip([{ name: 'a.txt', data: 'x' }])), /slideN\.xml/);
});

test('pptxToText dựng markdown có tiêu đề slide', () => {
  const text = pptxToText(readPptx(pptx()));
  assert.match(text, /## Slide 1 — Slide một/);
  assert.match(text, /## Slide 3 — Slide mười/);
  assert.match(text, /điểm A/);
});

test('pptxToText format text dùng dải phân cách thay vì heading', () => {
  const text = pptxToText(readPptx(pptx()), { format: 'text' });
  assert.match(text, /--- Slide 1: Slide một ---/);
  assert.doesNotMatch(text, /^##/m);
});

const presentation = (rids) => `<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${rids.map((r, i) => `<p:sldId id="${256 + i}" r:id="${r}"/>`).join('')}</p:sldIdLst></p:presentation>`;
const rels = (pairs) => `<Relationships>${pairs.map(([id, target, type = 'slide']) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

test('thứ tự slide theo sldIdLst + rels, KHÔNG theo số trong tên file', () => {
  const buf = makeZip([
    { name: 'ppt/presentation.xml', data: presentation(['rId3', 'rId2']) },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId2', 'slides/slide1.xml'], ['rId3', '/ppt/slides/slide2.xml']]) },
    { name: 'ppt/slides/slide1.xml', data: slide('Một') },
    { name: 'ppt/slides/slide2.xml', data: slide('Hai') },
  ]);
  const { slides, warnings } = readPptx(buf);
  assert.deepEqual(slides.map((s) => s.title), ['Hai', 'Một']);
  assert.deepEqual(slides.map((s) => s.number), [1, 2]);
  assert.equal(warnings.some((w) => /thứ tự/.test(w)), false);
});

test('thiếu presentation.xml → rơi về thứ tự theo tên file kèm warning', () => {
  const { slides, warnings } = readPptx(pptx());
  assert.deepEqual(slides.map((s) => s.title), ['Slide một', 'Slide hai', 'Slide mười']);
  assert.ok(warnings.some((w) => /thứ tự slide/.test(w)));
});

test('notes ghép qua slides/_rels/slideN.xml.rels, không theo số', () => {
  const buf = makeZip([
    { name: 'ppt/slides/slide1.xml', data: slide('A') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rId9', '../notesSlides/notesSlide7.xml', 'notesSlide']]) },
    { name: 'ppt/notesSlides/notesSlide7.xml', data: notes('ghi chú của A') },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes('KHÔNG phải của A') },
  ]);
  const { slides } = readPptx(buf, { includeNotes: true });
  assert.equal(slides[0].notes, 'ghi chú của A');
});

test('slide có rels nhưng không trỏ notesSlide → không đoán notes theo số', () => {
  const buf = makeZip([
    { name: 'ppt/slides/slide1.xml', data: slide('A') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rId1', '../slideLayouts/slideLayout1.xml', 'slideLayout']]) },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes('của slide khác') },
  ]);
  assert.equal(readPptx(buf, { includeNotes: true }).slides[0].notes, null);
});
