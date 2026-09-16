/*
 * Getting a place out of whatever the user pasted.
 *
 * Two kinds of input arrive here: a KML file drawn in Google Earth, which
 * carries whole rings, and a single point typed or pasted as text. Both end up
 * as plain [lon, lat] numbers so nothing downstream has to care which it was.
 */

/** Pull every usable ring out of KML text.
 *
 * Walks `<coordinates>` wherever it appears rather than following the
 * Placemark/Polygon/outerBoundaryIs path, because Google Earth nests those
 * differently depending on how the shape was drawn, and MultiGeometry adds
 * another layer again. Anything with three points is a ring worth measuring;
 * a one- or two-point `<coordinates>` is a pin or a line and is skipped. */
export function ringsFromKml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("That file is not readable KML.");
  }

  // querySelectorAll rather than getElementsByTagName: KML declares a default
  // namespace, and tag-name lookup against a namespaced XML document behaves
  // differently between parsers. Matching everything and checking localName is
  // the one reading that is the same everywhere.
  const rings = [];
  for (const node of doc.querySelectorAll("*")) {
    if (node.localName !== "coordinates") continue;

    const points = [];
    for (const token of (node.textContent || "").trim().split(/\s+/)) {
      if (!token) continue;
      const [lon, lat] = token.split(",").slice(0, 2).map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
    }

    // KML closes its rings; we store them open so no vertex is counted twice.
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) {
      points.pop();
    }
    if (points.length >= 3) rings.push(points);
  }

  if (!rings.length) throw new Error("No polygons found in that KML.");
  return rings;
}

/** The name a KML gives itself, for labelling the result. */
export function nameFromKml(text, fallback) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  for (const node of doc.querySelectorAll("*")) {
    if (node.localName === "name" && node.textContent.trim()) {
      // Google Earth names the Document after the file, extension and all.
      return node.textContent.trim().replace(/\.kml$/i, "");
    }
  }
  return fallback;
}

function check(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Those do not look like coordinates.");
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`Out of range: ${lat}, ${lon}`);
  }
  return { lat, lon };
}

/** Read a single point from text.
 *
 * Accepts "23.5275, 90.8431", "90.8431E, 23.5286N" either way round, and the
 * degree-marked forms Google Earth copies out. Hemisphere letters decide the
 * order when they are present, because a pasted pair is otherwise ambiguous
 * the moment both numbers are under 90. */
export function parsePoint(text) {
  const input = text.trim().replace(/[()]/g, "");
  const parts = input.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error("Expected two numbers, like 23.5275, 90.8431");

  const numbers = parts.map((part) => {
    const found = part.match(/-?\d+(\.\d+)?/);
    if (!found) throw new Error(`Not a number: ${part}`);
    let value = Number(found[0]);
    if (/[SW]/i.test(part) && value > 0) value = -value;   // "12.5 S" is -12.5
    return value;
  });

  const eastWestFirst = /[EW]/i.test(parts[0]);
  const [lat, lon] = eastWestFirst
    ? [numbers[1], numbers[0]]
    : [numbers[0], numbers[1]];
  return check(lat, lon);
}

/** Read a point out of a full Google Maps URL.
 *
 * Maps stores the location in several places depending on how the link was
 * made, and they do not always agree, so they are tried in order of how
 * deliberate each one is:
 *
 *   !3dLAT!4dLON        the pinned place -- the thing the link is *of*
 *   /search/LAT,+LON    what was searched for; how a short link resolves
 *   ?q=LAT,LON          the same, in the older query form
 *   @LAT,LON            where the camera happens to sit, which can have been
 *                       panned away from the pin entirely
 */
export function parseMapsUrl(url) {
  const pin = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) return check(Number(pin[1]), Number(pin[2]));

  // The "+" is a space that survived URL encoding: "23.5, 90.8" searched for.
  const path = url.match(
    /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?),\+?\s*(-?\d+(?:\.\d+)?)/,
  );
  if (path) return check(Number(path[1]), Number(path[2]));

  const query = url.match(/[?&](?:q|query|ll|center)=(-?\d+(?:\.\d+)?),\+?\s*(-?\d+(?:\.\d+)?)/);
  if (query) return check(Number(query[1]), Number(query[2]));

  const camera = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (camera) return check(Number(camera[1]), Number(camera[2]));

  throw new Error("No coordinates in that link.");
}

export const isShortLink = (text) => /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(text);

const isUrl = (text) => /^https?:\/\//i.test(text.trim());

/* Why a short link cannot be followed here.
 *
 * `maps.app.goo.gl/XXXX` carries no coordinates of its own -- they are only in
 * the address it redirects to, and a page is not allowed to read where a
 * cross-origin redirect landed. The usual workaround is to bounce the link off
 * a public CORS relay, which means sending it to a stranger's server and
 * trusting that server to stay up; the ones on offer were unreachable when
 * this was built. So the link is not followed at all. Opening it yourself
 * takes one tap and the address bar then holds the coordinates, which the
 * parser above reads directly. */
const SHORT_LINK_HELP =
  "A shortened Maps link hides its coordinates, and a browser is not allowed " +
  "to follow it. Open the link, then copy the address bar back here -- or " +
  "read the coordinates off it and paste those.";

/** Turn anything the user typed or pasted into a point.
 *
 * Everything here happens on this device: no lookup service, no relay, and
 * nothing about the place chosen leaves the browser. */
export function resolvePoint(text) {
  const input = text.trim();
  if (!input) throw new Error("Nothing to look up.");
  if (!isUrl(input)) return parsePoint(input);
  if (isShortLink(input)) throw new Error(SHORT_LINK_HELP);
  return parseMapsUrl(input);
}
