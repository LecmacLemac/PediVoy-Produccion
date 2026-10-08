const META_WAMID_MAX_LENGTH = 255;
const META_WAMID_PATTERN = /^wamid\.[A-Za-z0-9._:-]+={0,2}$/;

export function validateMetaWamid(value) {
  if (typeof value !== 'string') return null;
  if (value.length > META_WAMID_MAX_LENGTH) return null;
  if (!META_WAMID_PATTERN.test(value)) return null;
  return value;
}
