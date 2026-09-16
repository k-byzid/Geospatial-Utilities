/*
 * Geospatial Utilities.
 *
 * Choose a place once -- by dropping a KML or pasting a location -- and then
 * read it two ways: its shape, measured here in the browser, and its climate,
 * fetched from NASA POWER. The place is shared, so switching tabs never means
 * entering it again.
 */
import { measure, areaOf, perimeterOf, boxAround } from "./geometry.js";
import { ringsFromKml, nameFromKml, resolvePoint } from "./parse.js";
import {
  PARAMS, CODES, fetchClimate, rollUp, summarise, toCsv,
  nameOf, unitOf, isTotal, yyyymmdd,
} from "./climate.js";
import { drawChart } from "./chart.js";

const VIEW_METRES = 1000;     // how far to show to each side of the centre
const POWER_START = "19810101";

/* Enough colours for any group of parameters that share a unit -- six is the
 * largest such group -- chosen to stay apart on both themes and for the
 * commonest colour blindness. */
const COLOURS = ["#2f6fed", "#e07b39", "#14894a", "#b5468f", "#7a5cd0", "#c02a2a"];

const state = {
  place: null,       // {lat, lon, name, rings, stats}
  climate: null,     // what fetchClimate returned
  rows: [],          // rolled up to whatever "every" says
  picked: ["T2M"],
  every: "month",
  map: null,
  layers: [],
  pending: null,     // AbortController for a climate fetch in flight
};

const $ = (id) => document.getElementById(id);
const show = (...ids) => ids.forEach((id) => { $(id).hidden = false; });
const hide = (...ids) => ids.forEach((id) => { $(id).hidden = true; });

function say(id, text, kind = "") {
  const node = $(id);
  node.textContent = text;
  node.className = `msg ${kind}`;
}

const nf = (value, places = 2) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "--"
    : value.toLocaleString(undefined, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      });

/* ------------------------------------------------------------- step 1 */

/** Take a chosen place and light up the rest of the app.
 *
 * `rings` is empty for a typed point: there is a location to get weather for
 * but no shape to measure, and the geometry panel says so rather than showing
 * a row of zeroes. */
function setPlace({ lat, lon, name, rings = [] }) {
  const stats = rings.length ? measure(rings, name) : null;
  const centre = stats ? [stats.centroid.lat, stats.centroid.lon] : [lat, lon];

  state.place = { lat: centre[0], lon: centre[1], name, rings, stats };
  state.climate = null;
  state.rows = [];

  hide("step-place", "climate-body");
  show("done-place", "tabs");
  $("done-place-text").textContent = stats
    ? `${name} -- ${stats.polygons} polygon${stats.polygons === 1 ? "" : "s"}, ` +
      `${nf(stats.area_acres, 3)} acres at ${nf(centre[0], 5)}, ${nf(centre[1], 5)}`
    : `${name} -- ${nf(centre[0], 5)}, ${nf(centre[1], 5)}`;

  say("climate-msg", "");
  openTab("map");
  drawStats();
  drawMap();
}

async function readKml(file) {
  say("place-msg", `Reading ${file.name}...`);
  try {
    const text = await file.text();
    const rings = ringsFromKml(text);
    const name = nameFromKml(text, file.name.replace(/\.[^.]+$/, ""));
    setPlace({ lat: 0, lon: 0, name, rings });
  } catch (error) {
    say("place-msg", error.message, "bad");
  }
}

function readTyped(text) {
  if (!text.trim()) return;
  try {
    const { lat, lon } = resolvePoint(text);
    setPlace({ lat, lon, name: `${nf(lat, 5)}, ${nf(lon, 5)}` });
  } catch (error) {
    say("place-msg", error.message, "bad");
  }
}

function wirePlaceInputs() {
  const zone = $("drop-zone");
  const input = $("file-input");

  input.addEventListener("change", () => {
    if (input.files[0]) readKml(input.files[0]);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((event) =>
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.add("over");
    }));
  ["dragleave", "drop"].forEach((event) =>
    zone.addEventListener(event, () => zone.classList.remove("over")));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) readKml(e.dataTransfer.files[0]);
  });

  $("btn-locate").addEventListener("click", () => readTyped($("coord-input").value));
  $("coord-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") readTyped($("coord-input").value);
  });

  document.querySelectorAll(".chip[data-coord]").forEach((chip) =>
    chip.addEventListener("click", () => {
      $("coord-input").value = chip.dataset.coord;
      readTyped(chip.dataset.coord);
    }));

  $("btn-change-place").addEventListener("click", () => {
    show("step-place");
    hide("done-place", "tabs", "panel-map", "panel-climate");
    say("place-msg", "");
  });
}

/* ---------------------------------------------------------------- tabs */

function openTab(which) {
  const onMap = which === "map";
  $("tab-map").setAttribute("aria-selected", String(onMap));
  $("tab-climate").setAttribute("aria-selected", String(!onMap));
  $("panel-map").hidden = !onMap;
  $("panel-climate").hidden = onMap;

  // Leaflet measures the container when it is created; a map built while its
  // panel was hidden has no size yet, so it is told to look again.
  if (onMap && state.map) state.map.invalidateSize();
}

/* ----------------------------------------------------------------- map */

function drawMap() {
  const { lat, lon, rings, stats } = state.place;

  if (!state.map) {
    state.map = L.map("map", { scrollWheelZoom: true });
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    });
    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" },
    );
    // Satellite first: a pond boundary is checked against the water, which a
    // street map does not show.
    satellite.addTo(state.map);
    L.control.layers({ Satellite: satellite, "Street map": street }).addTo(state.map);
  }

  state.layers.forEach((layer) => state.map.removeLayer(layer));
  state.layers = [];

  if (rings.length) {
    /* Overlapping rings are the normal case here -- a union file embeds copies
     * of the shapes it covers -- so fills are kept faint and strokes thin.
     * Stacked at full opacity the shared water would read as a different,
     * darker shape than the ponds that make it up. */
    const many = rings.length > 1;
    rings.forEach((ring, i) => {
      const colour = COLOURS[i % COLOURS.length];
      const layer = L.polygon(ring.map(([x, y]) => [y, x]), {
        color: colour,
        weight: many ? 1.5 : 2.5,
        opacity: many ? 0.9 : 1,
        fillColor: colour,
        fillOpacity: many ? 0.08 : 0.18,
      }).addTo(state.map);
      layer.bindPopup(
        `<b>Polygon ${i + 1}</b><br>${nf(areaOf(ring), 0)} m&sup2; ` +
        `(${nf(areaOf(ring) / 4046.8564224, 3)} acres)<br>` +
        `${nf(perimeterOf(ring), 0)} m around, ${ring.length} vertices`,
      );
      state.layers.push(layer);
    });
  } else {
    state.layers.push(L.marker([lat, lon]).addTo(state.map));
  }

  /* A kilometre to each side is the framing asked for, but a boundary wider
   * than that must not be cropped, so the two are combined. */
  const view = L.latLngBounds(boxAround(lat, lon, VIEW_METRES));
  if (stats) {
    view.extend([[stats.bounds.south, stats.bounds.west], [stats.bounds.north, stats.bounds.east]]);
  }
  state.map.fitBounds(view, { padding: [12, 12] });
  state.map.invalidateSize();
}

function drawStats() {
  const list = $("stats-list");
  const { stats, lat, lon, name } = state.place;
  list.replaceChildren();

  const rows = stats
    ? [
        ["Name", stats.file, true],
        ["Polygons", String(stats.polygons)],
        ["Vertices", String(stats.vertices)],
        ["Area", `${nf(stats.area_sqm)} m²`, true],
        ["", `${nf(stats.area_acres, 4)} acres`],
        ["", `${nf(stats.area_sqft)} ft²`],
        ["", `${nf(stats.area_sqkm, 6)} km²`],
        ["", `${nf(stats.area_sqmi, 6)} mi²`],
        ["Perimeter", `${nf(stats.perimeter_m)} m`, true],
        ["", `${nf(stats.perimeter_ft)} ft`],
        ["Centre", `${nf(stats.centroid.lat, 6)}, ${nf(stats.centroid.lon, 6)}`],
        ["North", nf(stats.bounds.north, 6)],
        ["South", nf(stats.bounds.south, 6)],
        ["East", nf(stats.bounds.east, 6)],
        ["West", nf(stats.bounds.west, 6)],
      ]
    : [["Name", name, true], ["Latitude", nf(lat, 6)], ["Longitude", nf(lon, 6)]];

  for (const [label, value, strong] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (strong) dd.className = "strong";
    list.append(dt, dd);
  }

  $("stats-empty").hidden = Boolean(stats);
  $("stats-actions").hidden = !stats;
  $("rings").hidden = !stats;
  if (stats) drawRings();
}

function drawRings() {
  const body = $("rings-table").querySelector("tbody");
  body.replaceChildren();

  state.place.rings.forEach((ring, i) => {
    const area = areaOf(ring);
    const row = document.createElement("tr");
    for (const text of [
      String(i + 1), String(ring.length), nf(area), nf(area / 4046.8564224, 4),
      nf(perimeterOf(ring)),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }

    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.className = "ghost small";
    button.textContent = "Zoom to";
    button.addEventListener("click", () => {
      openTab("map");
      state.map.fitBounds(state.layers[i].getBounds(), { padding: [30, 30] });
      state.layers[i].openPopup();
    });
    cell.append(button);
    row.append(cell);
    body.append(row);
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const safeName = (name) => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "place";

function wireMapActions() {
  $("tab-map").addEventListener("click", () => openTab("map"));
  $("tab-climate").addEventListener("click", () => openTab("climate"));

  $("btn-copy-json").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(state.place.stats, null, 2));
    const button = $("btn-copy-json");
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy JSON"; }, 1400);
  });

  $("btn-download-json").addEventListener("click", () => {
    download(
      `${safeName(state.place.name)}_geometry.json`,
      JSON.stringify(state.place.stats, null, 2),
      "application/json",
    );
  });
}

/* ------------------------------------------------------------- climate */

function rangeChosen() {
  const preset = $("range-preset").value;
  const today = new Date();
  // POWER publishes a few days behind, so the window stops short of today
  // rather than asking for days that do not exist yet and being refused.
  const end = new Date(today.getTime() - 3 * 86400000);

  if (preset === "custom") {
    const from = $("date-start").value;
    const to = $("date-end").value;
    if (!from || !to) throw new Error("Pick both dates.");
    if (from > to) throw new Error("The start date is after the end date.");
    return [from.replaceAll("-", ""), to.replaceAll("-", "")];
  }
  if (preset === "all") return [POWER_START, yyyymmdd(end)];

  const start = new Date(end.getTime() - Number(preset) * 86400000);
  return [yyyymmdd(start), yyyymmdd(end)];
}

async function loadClimate() {
  let start;
  let end;
  try {
    [start, end] = rangeChosen();
  } catch (error) {
    say("climate-msg", error.message, "bad");
    return;
  }

  state.pending?.abort();
  state.pending = new AbortController();

  $("btn-load-climate").disabled = true;
  say("climate-msg", "Asking NASA POWER...", "busy");

  try {
    const { lat, lon } = state.place;
    state.climate = await fetchClimate(lat, lon, start, end, state.pending.signal);
    if (!state.climate.rows.length) throw new Error("No days came back for that range.");

    // A long range plotted a day at a time is thousands of points in a few
    // hundred pixels, so it is rolled up unless the user asked otherwise.
    if (state.climate.rows.length > 800 && $("every").value === "day") {
      $("every").value = "month";
      state.every = "month";
    }

    regroup();
    show("climate-body");
    const days = state.climate.rows.length;
    say("climate-msg", `${days.toLocaleString()} days loaded.`, "ok");
  } catch (error) {
    if (error.name === "AbortError") return;
    say("climate-msg", error.message, "bad");
  } finally {
    $("btn-load-climate").disabled = false;
    state.pending = null;
  }
}

/** Re-roll the loaded days and redraw everything that reads them. */
function regroup() {
  state.rows = rollUp(state.climate.rows, state.every);
  drawPicker();
  drawSeries();
  drawSummary();
}

/* Parameters are plotted together only when their units match -- two units on
 * one axis cannot both be read off it -- so picking across a boundary starts
 * a fresh selection rather than silently rescaling the chart. */
const unitFor = (code) => unitOf(state.climate.units, code);

function togglePick(code) {
  const [first] = state.picked;
  if (state.picked.includes(code)) {
    if (state.picked.length > 1) state.picked = state.picked.filter((c) => c !== code);
  } else if (first && unitFor(code) === unitFor(first)) {
    state.picked = [...state.picked, code].slice(-COLOURS.length);
  } else {
    state.picked = [code];
  }
  drawPicker();
  drawSeries();
}

function drawPicker() {
  const host = $("picker-groups");
  host.replaceChildren();

  const groups = [...new Set(PARAMS.map((p) => p.group))];
  for (const group of groups) {
    const wrap = document.createElement("div");
    wrap.className = "group";
    const title = document.createElement("div");
    title.className = "group-name";
    title.textContent = group;
    const items = document.createElement("div");
    items.className = "group-items";

    for (const param of PARAMS.filter((p) => p.group === group)) {
      const at = state.picked.indexOf(param.code);
      const button = document.createElement("button");
      button.className = at >= 0 ? "pill on" : "pill";
      button.setAttribute("aria-pressed", String(at >= 0));
      if (at >= 0) button.style.color = COLOURS[at % COLOURS.length];

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      button.append(swatch, document.createTextNode(param.name));
      button.addEventListener("click", () => togglePick(param.code));
      items.append(button);
    }

    wrap.append(title, items);
    host.append(wrap);
  }
}

function drawSeries() {
  const series = state.picked.map((code, i) => ({
    code,
    label: nameOf(code),
    colour: COLOURS[i % COLOURS.length],
    // A total is a quantity that accumulated over the bucket, which reads as
    // a column; a state the day was in reads as a line.
    kind: isTotal(code) ? "bar" : "line",
    points: state.rows.map((row) => ({ label: row.label, value: row.values[code] })),
  }));

  $("chart-title").textContent = series.map((s) => s.label).join(" · ");
  drawChart($("chart"), series, {
    unit: unitFor(state.picked[0]),
    onHover: (i) => showReadout(i, series),
  });
}

function showReadout(i, series) {
  const host = $("readout");
  host.replaceChildren();
  if (i === null) return;

  const when = document.createElement("b");
  when.textContent = state.rows[i].label;
  host.append(when, document.createTextNode("  "));

  for (const line of series) {
    const value = state.rows[i].values[line.code];
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = line.colour;
    host.append(
      swatch,
      document.createTextNode(`${value === null ? "no data" : nf(value, 2)}   `),
    );
  }
}

function drawSummary() {
  const body = $("summary-table").querySelector("tbody");
  body.replaceChildren();

  for (const code of CODES) {
    const stat = summarise(state.climate.rows, code);
    const row = document.createElement("tr");

    const cells = [
      nameOf(code),
      unitFor(code),
      // Rainfall's useful number over years is how much fell, not how much
      // fell on an average day, so a total is summarised as its total.
      isTotal(code) ? nf(stat.total, 1) : nf(stat.mean, 2),
      nf(stat.min, 2),
      nf(stat.max, 2),
      stat.count.toLocaleString(),
      stat.missing.toLocaleString(),
    ];
    cells.forEach((text, i) => {
      const cell = document.createElement("td");
      cell.textContent = text;
      if (i === 6 && stat.missing) cell.className = "missing";
      if (i === 2 && isTotal(code)) cell.title = "Total over the range, not a daily mean";
      row.append(cell);
    });

    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.className = "ghost small";
    button.textContent = "Plot";
    button.addEventListener("click", () => {
      state.picked = [code];
      drawPicker();
      drawSeries();
      $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    cell.append(button);
    row.append(cell);
    body.append(row);
  }
}

function wireClimate() {
  $("range-preset").addEventListener("change", () => {
    const custom = $("range-preset").value === "custom";
    $("custom-range").hidden = !custom;
    $("custom-range-end").hidden = !custom;
    if (custom && !$("date-end").value) {
      const end = new Date(Date.now() - 3 * 86400000);
      $("date-end").value = end.toISOString().slice(0, 10);
      $("date-start").value = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate())
        .toISOString().slice(0, 10);
    }
  });

  $("every").addEventListener("change", () => {
    state.every = $("every").value;
    if (state.climate) regroup();
  });

  $("btn-load-climate").addEventListener("click", loadClimate);

  $("btn-download-csv").addEventListener("click", () => {
    const label = state.every === "day" ? "Date" : state.every === "month" ? "Month" : "Year";
    download(
      `${safeName(state.place.name)}_climate_${state.every}.csv`,
      toCsv(state.rows, label),
      "text/csv",
    );
    say("csv-msg", `${state.rows.length} rows saved.`, "ok");
  });

  window.addEventListener("resize", () => {
    if (state.rows.length) drawSeries();
  });
}

wirePlaceInputs();
wireMapActions();
wireClimate();
