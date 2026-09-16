import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePoint, parseMapsUrl, resolvePoint, isShortLink } from "../assets/parse.js";

/* ringsFromKml is not covered here: it leans on the browser's DOMParser, which
 * Node has no equivalent of, and stubbing one would test the stub. The pure
 * text parsers below are where the fiddly cases live anyway. */

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("a plain pair reads as latitude then longitude", () => {
  const { lat, lon } = parsePoint("23.527537, 90.843139");
  near(lat, 23.527537);
  near(lon, 90.843139);
});

test("spacing and brackets do not matter", () => {
  for (const text of ["23.5,90.8", "  23.5 ,  90.8  ", "(23.5, 90.8)", "23.5; 90.8"]) {
    const { lat, lon } = parsePoint(text);
    near(lat, 23.5);
    near(lon, 90.8);
  }
});

test("a hemisphere letter decides the order, whichever way round", () => {
  const first = parsePoint("90.8439°E, 23.5286°N");
  const second = parsePoint("23.5286°N, 90.8439°E");
  near(first.lat, 23.5286);
  near(first.lon, 90.8439);
  assert.deepEqual(first, second);
});

test("south and west come back negative", () => {
  const { lat, lon } = parsePoint("2.154°S, 79.9224°W");
  near(lat, -2.154);
  near(lon, -79.9224);
});

test("an already-negative number is not negated twice", () => {
  const { lat } = parsePoint("-2.154 S, 79.9224 E");
  near(lat, -2.154);
});

test("nonsense is refused rather than guessed at", () => {
  for (const text of ["", "23.5", "somewhere nice", "23.5, 90.8, 12"]) {
    assert.throws(() => parsePoint(text));
  }
});

test("coordinates outside the world are refused", () => {
  assert.throws(() => parsePoint("95, 20"), /range/);
  assert.throws(() => parsePoint("20, 200"), /range/);
});

test("a pinned place in a Maps URL beats the camera position", () => {
  const url =
    "https://www.google.com/maps/place/Pond/@23.4,90.1,17z/data=!3m1!4b1!4m5!3d23.527537!4d90.843139";
  const { lat, lon } = parseMapsUrl(url);
  near(lat, 23.527537);
  near(lon, 90.843139);
});

test("a camera position is used when there is no pin", () => {
  const { lat, lon } = parseMapsUrl("https://www.google.com/maps/@23.5275,90.8431,17z");
  near(lat, 23.5275);
  near(lon, 90.8431);
});

test("a search query is read too", () => {
  const { lat, lon } = parseMapsUrl("https://maps.google.com/?q=-2.154,-79.9224");
  near(lat, -2.154);
  near(lon, -79.9224);
});

test("a link with no coordinates in it is refused", () => {
  assert.throws(() => parseMapsUrl("https://www.google.com/maps/place/Dhaka"), /No coordinates/);
});

/* This is the form a maps.app.goo.gl link actually redirects to -- the
 * coordinates land in the path, with the space after the comma still encoded
 * as a "+". Reading it is what makes "open the link, paste the address" work. */
test("the search path a short link resolves to is read", () => {
  const { lat, lon } = parseMapsUrl(
    "https://www.google.com/maps/search/23.527537,+90.843139?entry=tts&g_ep=Egoy",
  );
  near(lat, 23.527537);
  near(lon, 90.843139);
});

test("a place given as a path is read, and beats the camera", () => {
  const { lat, lon } = parseMapsUrl("https://www.google.com/maps/place/23.5275,90.8431/@1.1,2.2,17z");
  near(lat, 23.5275);
  near(lon, 90.8431);
});

test("short links are recognised", () => {
  assert.ok(isShortLink("https://maps.app.goo.gl/JFEEftYq79QZFSnP6"));
  assert.ok(isShortLink("https://goo.gl/maps/abc123"));
  assert.ok(!isShortLink("https://www.google.com/maps/@23.5,90.8,17z"));
});

/* A browser cannot read where a cross-origin redirect went, so the link is
 * refused with instructions rather than quietly handed to a third-party relay
 * that may be down or may keep the URL. */
test("a short link is refused with something to do about it", () => {
  assert.throws(
    () => resolvePoint("https://maps.app.goo.gl/JFEEftYq79QZFSnP6"),
    /Open the link/,
  );
});

test("resolvePoint takes plain coordinates and full links alike", () => {
  near(resolvePoint("23.5275, 90.8431").lat, 23.5275);
  near(resolvePoint("https://www.google.com/maps/@23.5275,90.8431,17z").lon, 90.8431);
  assert.throws(() => resolvePoint("   "), /Nothing to look up/);
});
