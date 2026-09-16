/*
 * Daily climate for a point, from NASA POWER.
 *
 * POWER serves a global reanalysis on a half-degree grid, so any point on land
 * has a record going back to 1981 without a station being anywhere near it.
 * This is a port of Tools/fetch-climate.py: the same fifteen parameters, the
 * same treatment of the fill value, so a chart here and a spreadsheet there
 * agree.
 */

const API = "https://power.larc.nasa.gov/api/temporal/daily/point";
const FILL = -999.0;              // POWER's "no value here", not a reading

/* The fifteen parameters, in the order they are shown. Grouped so the picker
 * can offer them by theme rather than as one long alphabetical list. */
export const PARAMS = [
  { code: "T2M", name: "Mean Air Temperature", group: "Temperature" },
  { code: "T2M_MAX", name: "Max Air Temperature", group: "Temperature" },
  { code: "T2M_MIN", name: "Min Air Temperature", group: "Temperature" },
  { code: "T2M_RANGE", name: "Diurnal Temperature Range", group: "Temperature" },
  { code: "TS", name: "Earth Skin Temperature", group: "Temperature" },
  { code: "T2MDEW", name: "Dew Point Temperature", group: "Temperature" },
  { code: "PRECTOTCORR", name: "Precipitation (Corrected)", group: "Water" },
  { code: "RH2M", name: "Relative Humidity at 2m", group: "Water" },
  { code: "EVPTRNS", name: "Evapotranspiration Energy Flux", group: "Water" },
  { code: "EVLAND", name: "Evaporation from Land", group: "Water" },
  { code: "ALLSKY_SFC_SW_DWN", name: "Solar Irradiance (All Sky)", group: "Sky" },
  { code: "ALLSKY_SFC_PAR_TOT", name: "Photosynthetically Active Radiation", group: "Sky" },
  { code: "CLOUD_AMT", name: "Cloud Amount", group: "Sky" },
  { code: "WS2M", name: "Wind Speed at 2m", group: "Air" },
  { code: "PS", name: "Surface Pressure", group: "Air" },
];

export const CODES = PARAMS.map((p) => p.code);

const byCode = new Map(PARAMS.map((p) => [p.code, p]));
export const nameOf = (code) => byCode.get(code)?.name ?? code;

/* Rain is a total over the day, so a month of it is a sum; everything else is
 * a state the day was in, so a month of it is an average. Summing humidity
 * would be meaningless, and averaging rainfall hides how wet the month was. */
const TOTALS = new Set(["PRECTOTCORR", "EVLAND"]);
export const isTotal = (code) => TOTALS.has(code);

export const yyyymmdd = (date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;

/** Fetch the daily record for a point between two YYYYMMDD stamps.
 *
 * Returns rows of {date, values} with missing readings left as null, so a gap
 * stays a gap instead of becoming a zero that would drag every average down. */
export async function fetchClimate(lat, lon, start, end, signal) {
  const url =
    `${API}?parameters=${CODES.join(",")}&community=AG` +
    `&latitude=${lat}&longitude=${lon}&start=${start}&end=${end}&format=JSON`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      response.status === 422
        ? "NASA POWER rejected that request -- check the dates are not in the future."
        : `NASA POWER returned ${response.status}.`,
    );
  }

  const payload = await response.json();
  const table = payload?.properties?.parameter;
  if (!table) throw new Error("NASA POWER sent no data for that point.");

  const days = Object.keys(table[CODES[0]] ?? {}).sort();
  const rows = days.map((day) => {
    const values = {};
    for (const code of CODES) {
      const value = table[code]?.[day];
      values[code] = value === undefined || value === FILL ? null : value;
    }
    return { day, date: new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`), values };
  });

  return { rows, units: payload.parameters ?? {}, lat, lon };
}

export const unitOf = (units, code) => units?.[code]?.units ?? "";

/* --------------------------------------------------------------- rolling up */

const keyOf = {
  day: (row) => row.day,
  month: (row) => row.day.slice(0, 6),
  year: (row) => row.day.slice(0, 4),
};

const labelOf = {
  day: (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6)}`,
  month: (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}`,
  year: (key) => key,
};

/** Roll daily rows up to months or years, one series per parameter.
 *
 * A bucket with no readings at all comes back null rather than zero, which
 * keeps a gap in the record looking like a gap on the chart. */
export function rollUp(rows, every) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf[every](row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, group]) => {
      const values = {};
      for (const code of CODES) {
        const present = group.map((r) => r.values[code]).filter((v) => v !== null);
        if (!present.length) {
          values[code] = null;
        } else {
          const total = present.reduce((sum, v) => sum + v, 0);
          values[code] = isTotal(code) ? total : total / present.length;
        }
      }
      return { key, label: labelOf[every](key), values, days: group.length };
    });
}

/** Min, max, mean and coverage for one parameter across the rows given. */
export function summarise(rows, code) {
  const present = rows.map((r) => r.values[code]).filter((v) => v !== null);
  if (!present.length) {
    return { count: 0, missing: rows.length, min: null, max: null, mean: null, total: null };
  }
  const total = present.reduce((sum, v) => sum + v, 0);
  return {
    count: present.length,
    missing: rows.length - present.length,
    min: Math.min(...present),
    max: Math.max(...present),
    mean: total / present.length,
    total,
  };
}

/** The rows as CSV, one column per parameter. */
export function toCsv(rows, dateHeader = "Date") {
  const lines = [[dateHeader, ...CODES].join(",")];
  for (const row of rows) {
    const label = row.label ?? row.day;
    const cells = CODES.map((code) => {
      const value = row.values[code];
      return value === null ? "" : Number(value.toFixed(4));
    });
    lines.push([label, ...cells].join(","));
  }
  return lines.join("\n");
}
