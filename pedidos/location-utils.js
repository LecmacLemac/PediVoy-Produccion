export function hasValidCoordinates(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  if (typeof lat === 'string' && lat.trim() === '') return false;
  if (typeof lng === 'string' && lng.trim() === '') return false;

  const latNum = Number(lat);
  const lngNum = Number(lng);
  return Number.isFinite(latNum)
    && Number.isFinite(lngNum)
    && latNum >= -90
    && latNum <= 90
    && lngNum >= -180
    && lngNum <= 180;
}
