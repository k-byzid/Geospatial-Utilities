/*
 * Measuring a ring of longitude/latitude points.
 *
 * A pond boundary is a closed ring on a sphere, not a polygon on a flat page,
 * so neither the area nor the perimeter can be had from plane geometry. Both
 * are computed on the sphere directly: the area by the spherical excess of the
 * ring, the perimeter by summing great-circle hops between neighbours.
 *
 * This is a port of Tools/check-pond-geometry.py and must keep agreeing with
 * it -- the numbers land in the same spreadsheets.
 */

const R = 6371008.8;              // WGS84 mean radius, metres

const SQFT = 0.09290304;          // square metres in a square foot
const ACRE = 4046.8564224;
const SQMI = 2589988.110336;
const FOOT = 0.3048;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Area of one ring in square metres.
 *
 * The sum below is the spherical excess written so that it needs only one
 * pass and no trigonometry beyond a sine per vertex. The sign of the result
 * tells you which way round the ring was drawn, which nobody asked for, so
 * it is thrown away. */
export function areaOf(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    total +=
      toRadians(lon2 - lon1) *
      (2 + Math.sin(toRadians(lat1)) + Math.sin(toRadians(lat2)));
  }
  return (Math.abs(total) * R * R) / 2;
}

/** Perimeter of one ring in metres, as great-circle distance.
 *
 * Haversine rather than the cosine rule: the sides of a pond are short, and
 * the cosine rule loses most of its precision exactly there. */
export function perimeterOf(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    const p1 = toRadians(lat1);
    const p2 = toRadians(lat2);
    const a =
      Math.sin((p2 - p1) / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return total;
}

const round = (value, places) => Number(value.toFixed(places));

/** Measure every ring of a shape and report it the way the Python tool does.
 *
 * Areas are summed across rings rather than combined geometrically, so a file
 * whose rings overlap -- the `+` union files do -- reports the sum of its
 * parts. That is what the survey spreadsheets record, and it is why those
 * files must never themselves be summed with the ponds they embed. */
export function measure(rings, name = "shape") {
  const area = rings.reduce((sum, ring) => sum + areaOf(ring), 0);
  const perimeter = rings.reduce((sum, ring) => sum + perimeterOf(ring), 0);

  const lons = rings.flatMap((ring) => ring.map(([lon]) => lon));
  const lats = rings.flatMap((ring) => ring.map(([, lat]) => lat));

  return {
    file: name,
    polygons: rings.length,
    vertices: rings.reduce((sum, ring) => sum + ring.length, 0),
    area_sqm: round(area, 2),
    area_sqft: round(area / SQFT, 2),
    area_acres: round(area / ACRE, 4),
    area_sqkm: round(area / 1e6, 6),
    area_sqmi: round(area / SQMI, 6),
    perimeter_m: round(perimeter, 2),
    perimeter_ft: round(perimeter / FOOT, 2),
    bounds: {
      west: Math.min(...lons),
      south: Math.min(...lats),
      east: Math.max(...lons),
      north: Math.max(...lats),
    },
    centroid: {
      lon: (Math.min(...lons) + Math.max(...lons)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    },
    // Closed again on the way out: the ring is stored open, but anything
    // reading this as GeoJSON expects the first point repeated at the end.
    coordinates: rings.map((ring) => [...ring, ring[0]]),
  };
}

/** A box `metres` to every side of a point, as [[south, west], [north, east]].
 *
 * A degree of longitude shrinks towards the poles, so it is widened by the
 * cosine of the latitude; otherwise the box would be too narrow everywhere
 * but the equator. */
export function boxAround(lat, lon, metres) {
  const dLat = (metres / R) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos(toRadians(lat)));
  return [
    [lat - dLat, lon - dLon],
    [lat + dLat, lon + dLon],
  ];
}
