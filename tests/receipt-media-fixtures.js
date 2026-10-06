import sharp from 'sharp';

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oKBgIOGwOy5TUAAAAKSURBVAjXY2gAAACCAIHdQ2r0AAAAAElFTkSuQmCC';
const WEBP_BASE64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=';


export const validJpeg = () => Buffer.from(JPEG_BASE64, 'base64');
export const validPng = () => Buffer.from(PNG_BASE64, 'base64');
export const validWebp = () => Buffer.from(WEBP_BASE64, 'base64');
const VARIANT_RAW = Buffer.from(Array.from({ length: 16 }, (_, index) => [
  index * 13 % 256,
  index * 29 % 256,
  index * 47 % 256,
  index % 3 === 0 ? 80 : 255,
]).flat());
const variantImage = () => sharp(VARIANT_RAW, { raw: { width: 4, height: 4, channels: 4 } });

export const validJpegBaseline = () => variantImage().jpeg({ progressive: false, quality: 80 }).toBuffer();
export const validJpegProgressive = () => variantImage().jpeg({ progressive: true, quality: 80 }).toBuffer();
export const validPngPalette = () => variantImage().png({ palette: true, colours: 16 }).toBuffer();
export const validPngInterlaced = () => variantImage().png({ progressive: true }).toBuffer();
export const validWebpLossy = () => variantImage().webp({ lossless: false, quality: 75 }).toBuffer();
export const validWebpLosslessAlpha = () => variantImage().webp({ lossless: true }).toBuffer();

export const corruptJpegThatPassesStructure = () => Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAf8AAD8AVN//2Q==', 'base64');
export const corruptPngThatPassesStructure = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oKBgIOGwOy5TUAAAAKSURBVADXY2gAAACCAIHOlCoAAAAAAElFTkSuQmCC', 'base64');
export const corruptWebpThatPassesStructure = () => Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEA/f/L2lv//I//AQRr/wA=', 'base64');

export function xrefCorruptPdf() {
  const buffer = Buffer.from(validPdf());
  const text = buffer.toString('latin1');
  const xrefOffset = text.indexOf('xref\n');
  const entryMarker = text.indexOf(' 00000 n ', xrefOffset);
  const entryOffset = entryMarker - 10;
  const original = Number(text.slice(entryOffset, entryOffset + 10));
  buffer.write(String(original + 7).padStart(10, '0'), entryOffset, 'latin1');
  return buffer;
}

export function validPdfWithPages(pageBoxes = [[0, 0, 10, 10]]) {
  const pageObjectIds = pageBoxes.map((_, index) => 3 + index * 2);
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageBoxes.length} >>\nendobj\n`,
  ];
  for (const [index, box] of pageBoxes.entries()) {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${box.join(' ')}] /Contents ${contentId} 0 R >>\nendobj\n`,
      `${contentId} 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n`,
    );
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(text, 'latin1'));
    text += object;
  }
  const xrefOffset = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 ${objects.length + 1}\n`;
  text += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

export const validPdf = () => validPdfWithPages();
