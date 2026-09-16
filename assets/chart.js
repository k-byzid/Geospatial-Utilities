/*
 * A small line-and-bar chart, drawn as SVG.
 *
 * Hand-rolled rather than pulled from a library: the app needs one chart type,
 * and an SVG the browser lays out itself scales and prints without any of the
 * canvas resizing a chart library exists to handle.
 */

const NS = "http://www.w3.org/2000/svg";
const PAD = { top: 14, right: 16, bottom: 26, left: 52 };

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/** Round a range out to friendly numbers, and say how far apart to tick it.
 *
 * Axis labels like 21.837 are unreadable at a glance, so the range is widened
 * to the nearest 1, 2 or 5 times a power of ten -- the steps people already
 * read prices and thermometers in. */
function niceScale(low, high) {
  if (low === high) {
    low -= 0.5;
    high += 0.5;
  }
  const rough = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= rough) * magnitude;
  return { min: Math.floor(low / step) * step, max: Math.ceil(high / step) * step, step };
}

const format = (value) => {
  const size = Math.abs(value);
  if (size >= 1000) return value.toFixed(0);
  if (size >= 10) return value.toFixed(1);
  return value.toFixed(2);
};

/**
 * Draw `series` into `host`.
 *
 * series: [{code, label, points: [{label, value}], kind: "line"|"bar", colour}]
 * Every series shares one vertical axis, so only comparable parameters should
 * be handed in together -- the picker is what keeps that true.
 */
export function drawChart(host, series, { unit = "", onHover } = {}) {
  host.replaceChildren();
  const drawn = series.filter((s) => s.points.some((p) => p.value !== null));

  if (!drawn.length) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Nothing to plot for this range.";
    host.append(empty);
    return;
  }

  const width = Math.max(320, host.clientWidth || 720);
  const height = 300;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;

  const values = drawn.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v !== null);
  // Bars are read against zero, so their axis has to include it or a column's
  // height stops meaning anything.
  const hasBars = drawn.some((s) => s.kind === "bar");
  const scale = niceScale(
    hasBars ? Math.min(0, ...values) : Math.min(...values),
    Math.max(...values),
  );

  const count = drawn[0].points.length;
  const x = (i) => PAD.left + (count === 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
  const y = (value) =>
    PAD.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "chart",
    role: "img",
    "aria-label": drawn.map((s) => s.label).join(", "),
  });

  for (let value = scale.min; value <= scale.max + 1e-9; value += scale.step) {
    const at = y(value);
    svg.append(el("line", {
      x1: PAD.left, x2: width - PAD.right, y1: at, y2: at, class: "grid",
    }));
    const text = el("text", { x: PAD.left - 8, y: at + 4, class: "tick", "text-anchor": "end" });
    text.textContent = format(value);
    svg.append(text);
  }

  // At most six date labels: more than that and they collide, and the exact
  // date of a point is what the hover readout is for.
  const every = Math.max(1, Math.ceil(count / 6));
  drawn[0].points.forEach((point, i) => {
    if (i % every && i !== count - 1) return;
    const text = el("text", {
      x: x(i), y: height - 8, class: "tick", "text-anchor": "middle",
    });
    text.textContent = point.label;
    svg.append(text);
  });

  for (const line of drawn) {
    if (line.kind === "bar") {
      const barWidth = Math.max(1, (plotWidth / Math.max(count, 1)) * 0.7);
      const base = y(Math.max(scale.min, 0));
      line.points.forEach((point, i) => {
        if (point.value === null) return;
        const top = y(point.value);
        svg.append(el("rect", {
          x: x(i) - barWidth / 2,
          y: Math.min(top, base),
          width: barWidth,
          height: Math.max(1, Math.abs(base - top)),
          fill: line.colour,
          class: "bar",
        }));
      });
      continue;
    }

    // A run of nulls breaks the path rather than being bridged, so a gap in
    // the record is visible instead of being drawn as a straight line.
    let path = "";
    let pen = "M";
    line.points.forEach((point, i) => {
      if (point.value === null) {
        pen = "M";
        return;
      }
      path += `${pen}${x(i).toFixed(1)},${y(point.value).toFixed(1)} `;
      pen = "L";
    });
    svg.append(el("path", { d: path.trim(), fill: "none", stroke: line.colour, "stroke-width": 2 }));
  }

  const marker = el("line", { class: "cursor", y1: PAD.top, y2: PAD.top + plotHeight, opacity: 0 });
  svg.append(marker);

  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * width;
    const i = Math.round(((at - PAD.left) / plotWidth) * (count - 1));
    if (i < 0 || i >= count) return;
    marker.setAttribute("x1", x(i));
    marker.setAttribute("x2", x(i));
    marker.setAttribute("opacity", 1);
    onHover?.(i);
  });
  svg.addEventListener("pointerleave", () => {
    marker.setAttribute("opacity", 0);
    onHover?.(null);
  });

  host.append(svg);
  if (unit) {
    const caption = document.createElement("p");
    caption.className = "chart-unit";
    caption.textContent = unit;
    host.append(caption);
  }
}
