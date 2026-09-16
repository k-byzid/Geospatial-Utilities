import { test } from "node:test";
import assert from "node:assert/strict";

import { areaOf, perimeterOf, measure, boxAround } from "../assets/geometry.js";

const near = (a, b, tolerance) =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${a} is not within ${tolerance} of ${b}`,
  );

/* A square of 0.01 degrees sitting on the equator. A degree of latitude is
 * R * pi / 180 everywhere, so each side is about 1112 m and the square is
 * about 1.2365 km2 -- close enough to a plane square to check against one. */
const SQUARE = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];
const SIDE = 6371008.8 * ((0.01 * Math.PI) / 180);

test("a small square measures what plane geometry says it should", () => {
  near(areaOf(SQUARE), SIDE * SIDE, SIDE * SIDE * 0.001);
  near(perimeterOf(SQUARE), 4 * SIDE, 4 * SIDE * 0.001);
});

test("area does not depend on which way round the ring was drawn", () => {
  near(areaOf([...SQUARE].reverse()), areaOf(SQUARE), 1e-6);
});

test("area does not depend on which vertex comes first", () => {
  const rotated = [...SQUARE.slice(2), ...SQUARE.slice(0, 2)];
  near(areaOf(rotated), areaOf(SQUARE), 1e-6);
});

test("moving a ring away from the equator narrows it", () => {
  const north = SQUARE.map(([lon, lat]) => [lon, lat + 60]);
  // A degree of longitude shrinks by cos(latitude), so the same degree box
  // covers about half the ground at 60 degrees north.
  near(areaOf(north) / areaOf(SQUARE), Math.cos((60.005 * Math.PI) / 180), 0.002);
});

test("a ring traced twice as wide covers four times the area", () => {
  const big = SQUARE.map(([lon, lat]) => [lon * 2, lat * 2]);
  near(areaOf(big) / areaOf(SQUARE), 4, 0.001);
});

test("measure converts one area into every unit consistently", () => {
  const stats = measure([SQUARE], "square");
  near(stats.area_sqft, stats.area_sqm / 0.09290304, 1);
  near(stats.area_acres, stats.area_sqm / 4046.8564224, 1e-3);
  near(stats.area_sqkm, stats.area_sqm / 1e6, 1e-6);
  near(stats.area_sqmi, stats.area_sqm / 2589988.110336, 1e-6);
  near(stats.perimeter_ft, stats.perimeter_m / 0.3048, 1);
});

test("measure sums its rings rather than merging them", () => {
  const one = measure([SQUARE], "one");
  const twice = measure([SQUARE, SQUARE], "twice");
  assert.equal(twice.polygons, 2);
  assert.equal(twice.vertices, 8);
  near(twice.area_sqm, one.area_sqm * 2, 0.01);
});

test("measure reports the bounds and centre of the ring", () => {
  const stats = measure([SQUARE], "square");
  assert.deepEqual(stats.bounds, { west: 0, south: 0, east: 0.01, north: 0.01 });
  near(stats.centroid.lat, 0.005, 1e-12);
  near(stats.centroid.lon, 0.005, 1e-12);
});

test("measure closes the ring it hands back", () => {
  const [ring] = measure([SQUARE], "square").coordinates;
  assert.equal(ring.length, SQUARE.length + 1);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test("boxAround spans the distance asked for", () => {
  const [[south, west], [north, east]] = boxAround(0, 0, 1000);
  near(perimeterOf([[west, south], [east, south]]) / 2, 2000, 1);
  near(perimeterOf([[west, south], [west, north]]) / 2, 2000, 1);
});

test("boxAround widens in longitude as it moves north", () => {
  const equator = boxAround(0, 0, 1000);
  const high = boxAround(60, 0, 1000);
  const width = (box) => box[1][1] - box[0][1];
  near(width(high) / width(equator), 1 / Math.cos((60 * Math.PI) / 180), 0.001);
});
