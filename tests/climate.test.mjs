import { test } from "node:test";
import assert from "node:assert/strict";

import { CODES, rollUp, summarise, toCsv, isTotal, nameOf } from "../assets/climate.js";

/** Build rows the way fetchClimate would, with only the codes named set. */
const rows = (entries) =>
  entries.map(([day, values]) => {
    const full = Object.fromEntries(CODES.map((code) => [code, null]));
    return { day, date: new Date(), values: { ...full, ...values } };
  });

const JANUARY = rows([
  ["20240101", { T2M: 10, PRECTOTCORR: 1 }],
  ["20240102", { T2M: 20, PRECTOTCORR: 2 }],
  ["20240103", { T2M: 30, PRECTOTCORR: 3 }],
]);

test("a state is averaged over the bucket but a total is summed", () => {
  const [month] = rollUp(JANUARY, "month");
  assert.equal(month.values.T2M, 20);           // mean of 10, 20, 30
  assert.equal(month.values.PRECTOTCORR, 6);    // sum of 1, 2, 3
});

test("rainfall and land evaporation are the totals; nothing else is", () => {
  assert.ok(isTotal("PRECTOTCORR"));
  assert.ok(isTotal("EVLAND"));
  assert.ok(!isTotal("T2M"));
  assert.ok(!isTotal("RH2M"));
});

test("buckets are labelled and ordered by when they were", () => {
  const spread = rows([
    ["20240315", { T2M: 1 }], ["20240115", { T2M: 2 }], ["20230715", { T2M: 3 }],
  ]);
  // Named months, and still ordered by when they were rather than by name.
  assert.deepEqual(rollUp(spread, "month").map((r) => r.label),
    ["2023-July", "2024-January", "2024-March"]);
  assert.deepEqual(rollUp(spread, "year").map((r) => r.label), ["2023", "2024"]);
  assert.deepEqual(rollUp(spread, "day").map((r) => r.label),
    ["2023-07-15", "2024-01-15", "2024-03-15"]);
});

test("a missing day is left out of the average rather than counted as zero", () => {
  const gappy = rows([
    ["20240101", { T2M: 10 }], ["20240102", { T2M: null }], ["20240103", { T2M: 20 }],
  ]);
  const [month] = rollUp(gappy, "month");
  assert.equal(month.values.T2M, 15);           // not 10
  assert.equal(month.days, 3);
});

test("a bucket with nothing in it stays empty instead of becoming zero", () => {
  const [month] = rollUp(rows([["20240101", { T2M: null }]]), "month");
  assert.equal(month.values.T2M, null);
});

test("summarise reports the spread and how much was missing", () => {
  const stat = summarise(JANUARY, "T2M");
  assert.deepEqual(
    { min: stat.min, max: stat.max, mean: stat.mean, count: stat.count, missing: stat.missing },
    { min: 10, max: 30, mean: 20, count: 3, missing: 0 },
  );
});

test("summarise counts the gaps in a parameter that never reported", () => {
  const stat = summarise(JANUARY, "RH2M");
  assert.equal(stat.count, 0);
  assert.equal(stat.missing, 3);
  assert.equal(stat.mean, null);
});

test("a bucket names itself, its place in its group, and the group", () => {
  const one = rows([["20240915", { T2M: 1 }]]);

  const [month] = rollUp(one, "month");
  assert.equal(month.label, "2024-September");
  assert.equal(month.tick, "September");
  assert.equal(month.shortTick, "Sep");
  assert.equal(month.group, "2024");            // written once, under the year

  const [day] = rollUp(one, "day");
  assert.equal(day.tick, "15");
  assert.equal(day.group, "September 2024");

  // A year has nothing above it to be grouped under.
  const [year] = rollUp(one, "year");
  assert.equal(year.tick, "2024");
  assert.equal(year.group, null);
});

test("CSV has a column per parameter and blanks for the gaps", () => {
  const lines = toCsv(rollUp(JANUARY, "month"), "Month").split("\n");
  const header = lines[0].split(",");
  assert.equal(header[0], "Month");
  assert.equal(header.length, CODES.length + 1);

  const cells = lines[1].split(",");
  assert.equal(cells[0], "2024-January");
  assert.equal(cells[1 + CODES.indexOf("T2M")], "20");
  assert.equal(cells[1 + CODES.indexOf("RH2M")], "");   // never reported
});

test("every code has a readable name", () => {
  for (const code of CODES) {
    assert.notEqual(nameOf(code), code);
  }
  assert.equal(CODES.length, 15);
});
