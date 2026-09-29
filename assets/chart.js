/*
 * A small line-and-bar chart, drawn as SVG.
 *
 * Hand-rolled rather than pulled from a library: the app needs one chart type,
 * and an SVG the browser lays out itself scales and prints without any of the
 * canvas resizing a chart library exists to handle.
 *
 * Four things here are worth knowing before reading on:
 *
 *  - Parameters with different units can be plotted together. One unit gets a
 *    left axis, a second gets a right axis, and three or more fall back to
 *    scaling every series against its own range, since no one axis can be read
 *    for all of them.
 *  - Date labels go in two tiers: month names on one line, and under them the
 *    year, written once and centred beneath the run of months it covers, with a
 *    divider where one year gives way to the next. Nothing is turned on its
 *    side and nothing is stacked in a zigzag -- one line of months, one line of
 *    years.
 *  - The wheel zooms, and a drag moves the chart under the pointer. A drag is
 *    shown by sliding what is already drawn, and settled only when the pointer
 *    lifts, so the redraw happens once instead of on every mouse move.
 *  - The view is a window over the points, owned by the caller. The chart never
 *    changes it directly -- it reports where the wheel or a drag left it and the
 *    caller redraws -- so the chart and the readout cannot disagree.
 */

const NS = "http://www.w3.org/2000/svg";

const PAD = { top: 22, right: 16, bottom: 26, left: 54 };
const PLOT_HEIGHT = 252;         // of the plot itself; date labels go below it
const MIN_FONT = 10;             // smaller than this is not worth reading
const MAX_FONT = 13;
const NEAT = [1, 2, 3, 4, 6, 12];  // label every nth month, on a step that divides a year
const CHAR = 0.56;               // width of a digit, as a fraction of font size
const MIN_SPAN = 2;              // fewest buckets a zoom may leave in view
const DRAG_MIN = 4;              // px of travel before a press counts as a drag

let clipSeq = 0;                 // clip paths are found by id, so it must be new

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null) node.setAttribute(key, value);
  }
  return node;
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

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

/** Pick how to write the upper tier of date labels -- one per bucket.
 *
 * A bucket names itself twice, "September" and "Sep", so shortening is its own
 * business rather than a matter of cutting characters off a word. Neither form
 * carries the year: that is written once on the tier below, under the run of
 * months it covers, which is what keeps this tier short enough to stay upright
 * and on one line.
 *
 * The fuller name wins, then the larger font. Only when the shortest name will
 * not fit does the tier start skipping buckets, and it skips on a step that
 * divides a year -- every 2nd, 3rd, 4th or 6th month -- so the labels land on
 * the same months every year instead of drifting across them. */
function planTicks(points, plotWidth) {
  const forms = [(p) => p.tick ?? p.label, (p) => p.shortTick ?? p.tick ?? p.label];
  const slot = plotWidth / Math.max(points.length, 1);
  const roomFor = (form) => Math.max(...points.map((p) => form(p).length)) * CHAR;
  const neaten = (n) => NEAT.find((e) => e >= n) ?? Math.ceil(n / 12) * 12;

  for (const form of forms) {
    const room = roomFor(form);
    for (let font = MAX_FONT; font >= MIN_FONT; font -= 0.5) {
      if (room * font + 8 <= slot) return { form, font, every: 1 };
    }
  }

  // Out of room at every size: the short name, as large as it can be while a
  // whole tier of them still stands clear at the step chosen.
  const room = roomFor(forms[1]);
  for (let font = MAX_FONT; font >= MIN_FONT; font -= 0.5) {
    const every = neaten((room * font + 8) / slot);
    if (every <= points.length) return { form: forms[1], font, every };
  }
  return { form: forms[1], font: MIN_FONT, every: points.length };
}

/** The lower tier: runs of buckets that share a group, as {group, start, end}.
 *
 * Consecutive buckets with the same group name are one run, so a year that the
 * view only clips the edge of is still a run -- just a short one, which is why
 * the drawing checks whether its name fits before writing it. */
function planGroups(points) {
  const runs = [];
  points.forEach((point, at) => {
    if (point.group == null) return;
    const last = runs.at(-1);
    if (last && last.group === point.group) last.end = at;
    else runs.push({ group: point.group, start: at, end: at });
  });
  return runs;
}

/** Where each series sits vertically: which axis, and over what range.
 *
 * With one or two units every series sharing a unit shares an axis, so a
 * parameter is drawn at the same height whichever of its siblings is beside it.
 * With three or more there is no axis left to hang the third on, so each series
 * is scaled to its own range instead: the shapes stay comparable even though
 * the heights no longer all mean one thing. */
function planAxes(drawn, valuesIn) {
  const units = [...new Set(drawn.map((s) => s.unit ?? ""))];

  if (units.length <= 2) {
    const axes = units.map((unit, side) => {
      const mates = drawn.filter((s) => (s.unit ?? "") === unit);
      const values = mates.flatMap(valuesIn);
      // Bars are read against zero, so their axis has to include it or a
      // column's height stops meaning anything.
      const low = mates.some((s) => s.kind === "bar")
        ? Math.min(0, ...values)
        : Math.min(...values);
      return { unit, side, scale: niceScale(low, Math.max(...values)), colour: mates[0].colour };
    });
    return {
      mode: "shared",
      axes,
      axisOf: (line) => axes.find((a) => a.unit === (line.unit ?? "")),
      spanOf: (line) => axes.find((a) => a.unit === (line.unit ?? "")).scale,
    };
  }

  const own = new Map();
  for (const line of drawn) {
    const values = valuesIn(line);
    let low = line.kind === "bar" ? Math.min(0, ...values) : Math.min(...values);
    let high = Math.max(...values);
    if (low === high) {
      low -= 0.5;
      high += 0.5;
    }
    const breath = (high - low) * 0.06;         // so a line never sits on the frame
    own.set(line.code, { min: low - breath, max: high + breath });
  }
  return { mode: "own", axes: [], axisOf: () => null, spanOf: (line) => own.get(line.code) };
}

function resetButton(onViewChange) {
  const button = document.createElement("button");
  button.className = "ghost small";
  button.textContent = "Reset zoom";
  button.addEventListener("click", () => onViewChange(null));
  return button;
}

function note(host, text, onViewChange) {
  const message = document.createElement("p");
  message.className = "chart-empty";
  message.textContent = text;
  host.append(message);
  if (onViewChange) host.append(resetButton(onViewChange));
}

/**
 * Draw `series` into `host`.
 *
 * series: [{code, label, unit, kind: "line"|"bar", colour,
 *           points: [{label, short, value}]}]
 *
 * options:
 *   view          {from, to} indices of the buckets to show, or null for all
 *   onViewChange  called with a new {from, to}, or null meaning "all again"
 *   onHover       called with the index of the bucket under the pointer, or null
 *   plotHeight    how tall to draw the plot; full screen asks for more
 */
export function drawChart(host, series, {
  onHover, view = null, onViewChange, plotHeight = PLOT_HEIGHT,
} = {}) {
  host.replaceChildren();
  const drawn = series.filter((s) => s.points.some((p) => p.value !== null));
  if (!drawn.length) {
    note(host, "Nothing to plot for this range.");
    return;
  }

  const total = drawn[0].points.length;
  const from = clamp(Math.round(view?.from ?? 0), 0, Math.max(0, total - 1));
  const to = clamp(Math.round(view?.to ?? total - 1), from, total - 1);
  const count = to - from + 1;
  const span = count - 1;
  const zoomed = from > 0 || to < total - 1;

  const shown = (line) => line.points.slice(from, to + 1);
  const valuesIn = (line) => shown(line).map((p) => p.value).filter((v) => v !== null);

  const alive = drawn.filter((line) => valuesIn(line).length);
  if (!alive.length) {
    note(host, "No readings in this part of the range.", onViewChange);
    return;
  }

  const width = Math.max(320, host.clientWidth || 720);
  const axes = planAxes(alive, valuesIn);

  // The left gutter has to hold the widest number the axis will print, and a
  // second unit needs that room again on the right.
  const tickRoom = (axis) => {
    let widest = 0;
    for (let v = axis.scale.min; v <= axis.scale.max + 1e-9; v += axis.scale.step) {
      widest = Math.max(widest, format(v).length);
    }
    return widest * MAX_FONT * CHAR + 12;
  };
  const left = axes.mode === "own" ? 46 : Math.max(PAD.left, tickRoom(axes.axes[0]));
  const right = axes.mode === "shared" && axes.axes.length > 1
    ? Math.max(PAD.right, tickRoom(axes.axes[1]))
    : PAD.right;

  const plotWidth = width - left - right;
  const ruler = shown(alive[0]);
  const plan = planTicks(ruler, plotWidth);
  const runs = planGroups(ruler);

  const floor = PAD.top + plotHeight;
  const tickBase = floor + plan.font + 7;
  const groupFont = Math.min(MAX_FONT, plan.font + 1);
  const groupBase = tickBase + groupFont + 8;
  const bottom = Math.ceil((runs.length ? groupBase : tickBase) - floor + 7);
  const height = floor + bottom;

  const x = (i) =>
    left + (count === 1 ? plotWidth / 2 : ((i - from) / span) * plotWidth);
  const indexAt = (px) => (count === 1 ? from : from + ((px - left) / plotWidth) * span);

  const yFor = (line) => {
    const range = axes.spanOf(line);
    return (value) => floor - ((value - range.min) / (range.max - range.min)) * plotHeight;
  };

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: onViewChange ? "chart live" : "chart",
    role: "img",
    "aria-label":
      `${alive.map((s) => s.label).join(", ")}, ` +
      `${ruler[0].label} to ${ruler[count - 1].label}`,
  });

  /* Everything that slides under a drag lives in one group, clipped to the plot
   * so a drag cannot push a line out over the axis. */
  const clipId = `chart-clip-${(clipSeq += 1)}`;
  const defs = el("defs");
  const clip = el("clipPath", { id: clipId });
  clip.append(el("rect", {
    x: left, y: PAD.top - 2, width: plotWidth, height: plotHeight + bottom,
  }));
  defs.append(clip);
  const framed = el("g", { "clip-path": `url(#${clipId})` });
  const sliding = el("g");
  framed.append(sliding);

  /* -------------------------------------------------------------- the axes */

  if (axes.mode === "own") {
    // Nothing on this axis is a reading any more, so it is drawn as the share
    // of each series' own range, and real values are left to the readout.
    for (let part = 0; part <= 4; part += 1) {
      const at = floor - (part / 4) * plotHeight;
      svg.append(el("line", { x1: left, x2: width - right, y1: at, y2: at, class: "grid" }));
      const text = el("text", { x: left - 8, y: at + 4, class: "tick", "text-anchor": "end" });
      text.textContent = `${part * 25}%`;
      svg.append(text);
    }
    const caption = el("text", { x: left, y: 13, class: "axis-name" });
    caption.textContent = "each series across its own range -- hover for real values";
    svg.append(caption);
  } else {
    for (const axis of axes.axes) {
      const onLeft = axis.side === 0;
      for (let v = axis.scale.min; v <= axis.scale.max + 1e-9; v += axis.scale.step) {
        const at = floor - ((v - axis.scale.min) / (axis.scale.max - axis.scale.min)) * plotHeight;
        // One set of gridlines only: a second would not line up with the first
        // and the plot would read as graph paper.
        if (onLeft) {
          svg.append(el("line", { x1: left, x2: width - right, y1: at, y2: at, class: "grid" }));
        }
        const text = el("text", {
          x: onLeft ? left - 8 : width - right + 8,
          y: at + 4,
          class: "tick",
          "text-anchor": onLeft ? "end" : "start",
        });
        text.textContent = format(v);
        svg.append(text);
      }

      if (axis.unit) {
        const name = el("text", {
          x: onLeft ? left : width - right,
          y: 13,
          class: "axis-name",
          "text-anchor": onLeft ? "start" : "end",
          fill: axes.axes.length > 1 ? axis.colour : null,
        });
        name.textContent = axis.unit;
        svg.append(name);
      }
    }
  }

  /* ------------------------------------------------------------ date labels */

  /* Upper tier: the buckets. Counted from the start of each group rather than
   * from the edge of the view, so a thinned tier lands on the same months in
   * every year and does not shuffle along as the chart is dragged. */
  const startOfGroup = new Map(runs.map((run) => [run.group, run.start]));
  ruler.forEach((point, seen) => {
    const within = seen - (startOfGroup.get(point.group) ?? 0);
    if (plan.every > 1 && within % plan.every) return;
    const text = el("text", {
      x: Math.round(x(from + seen)),
      y: tickBase,
      class: "tick",
      "text-anchor": "middle",
      // Inline rather than an attribute: a stylesheet rule for .tick would
      // otherwise win over a presentation attribute and undo every size
      // worked out here, which is what made these labels look smeared.
      style: `font-size:${plan.font}px`,
    });
    text.textContent = plan.form(point);
    sliding.append(text);
  });

  /* Lower tier: the year each run of months belongs to, centred under the run,
   * with a divider between one run and the next. A run the view has clipped to
   * a month or two has no room for its name, and goes unnamed rather than
   * overlapping its neighbour. */
  runs.forEach((run, at) => {
    const leftEdge = x(from + run.start);
    const rightEdge = x(from + run.end);

    if (rightEdge - leftEdge + plotWidth / Math.max(count, 1) >= run.group.length * CHAR * groupFont) {
      const name = el("text", {
        x: Math.round((leftEdge + rightEdge) / 2),
        y: groupBase,
        class: "tick group-tick",
        "text-anchor": "middle",
        style: `font-size:${groupFont}px`,
      });
      name.textContent = run.group;
      sliding.append(name);
    }

    if (at) {
      const before = runs[at - 1];
      const at_ = (x(from + before.end) + leftEdge) / 2;
      // Stops at the x-axis: this divider belongs to the labels below it, not
      // to the plot, and running it up through the data would read as a mark
      // on the chart itself rather than a division between two years' labels.
      sliding.append(el("line", {
        x1: at_, x2: at_, y1: floor, y2: groupBase + 4, class: "tier",
      }));
    }
  });

  /* ------------------------------------------------------------ the series */

  const bars = alive.filter((s) => s.kind === "bar");

  for (const line of alive) {
    const y = yFor(line);
    const range = axes.spanOf(line);

    if (line.kind === "bar") {
      // Several bar series would cover each other, so each takes a slice of the
      // slot rather than all of them standing on the same spot.
      const slot = (plotWidth / Math.max(count, 1)) * 0.7;
      const barWidth = Math.max(1, slot / bars.length);
      const base = y(clamp(0, range.min, range.max));

      shown(line).forEach((point, seen) => {
        if (point.value === null) return;
        const top = y(point.value);
        sliding.append(el("rect", {
          x: x(from + seen) - slot / 2 + bars.indexOf(line) * barWidth,
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
    shown(line).forEach((point, seen) => {
      if (point.value === null) {
        pen = "M";
        return;
      }
      path += `${pen}${x(from + seen).toFixed(1)},${y(point.value).toFixed(1)} `;
      pen = "L";
    });
    sliding.append(el("path", {
      d: path.trim(), fill: "none", stroke: line.colour, "stroke-width": 2,
    }));

    // Zoomed in far enough that readings are well apart, the line alone hides
    // where they actually are.
    if (plotWidth / count > 18) {
      shown(line).forEach((point, seen) => {
        if (point.value === null) return;
        sliding.append(el("circle", {
          cx: x(from + seen), cy: y(point.value), r: 2.5, fill: line.colour, class: "dot",
        }));
      });
    }
  }

  const marker = el("line", { class: "cursor", y1: PAD.top, y2: floor, opacity: 0 });
  svg.append(defs, framed, marker);

  /* --------------------------------------------------------- pointer work */

  const localX = (event) => {
    const box = svg.getBoundingClientRect();
    return ((event.clientX - box.left) / box.width) * width;
  };

  // There is nothing to move to until part of the range is off screen.
  const canPan = Boolean(onViewChange) && zoomed && span > 0;
  let grab = null;                              // {at, moved} while dragging

  /* Held at the ends, so the chart cannot be dragged off into blank space. */
  const roomToSlide = (dx) => clamp(
    dx,
    (-(total - 1 - to) / span) * plotWidth,
    (from / span) * plotWidth,
  );

  svg.addEventListener("pointermove", (event) => {
    const at = localX(event);

    if (grab) {
      if (Math.abs(at - grab.at) >= DRAG_MIN) grab.moved = true;
      if (grab.moved) {
        sliding.setAttribute("transform", `translate(${roomToSlide(at - grab.at).toFixed(1)},0)`);
        marker.setAttribute("opacity", 0);
        onHover?.(null);
      }
      return;
    }

    const i = clamp(Math.round(indexAt(at)), from, to);
    marker.setAttribute("x1", x(i));
    marker.setAttribute("x2", x(i));
    marker.setAttribute("opacity", 1);
    onHover?.(i);
  });

  svg.addEventListener("pointerleave", () => {
    marker.setAttribute("opacity", 0);
    onHover?.(null);
  });

  if (onViewChange) {
    if (canPan) svg.classList.add("pannable");

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !canPan) return;
      grab = { at: localX(event), moved: false };
      svg.setPointerCapture(event.pointerId);
    });

    svg.addEventListener("pointerup", (event) => {
      if (!grab) return;
      const dx = roomToSlide(localX(event) - grab.at);
      const dragged = grab.moved;
      grab = null;
      sliding.removeAttribute("transform");
      if (!dragged) return;

      const start = clamp(Math.round(from - (dx / plotWidth) * span), 0, total - 1 - span);
      onViewChange(
        start === 0 && start + span >= total - 1 ? null : { from: start, to: start + span },
      );
    });

    svg.addEventListener("pointercancel", () => {
      grab = null;
      sliding.removeAttribute("transform");
    });

    // Not passive: the page must not scroll while the wheel is zooming.
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const held = clamp(indexAt(localX(event)), from, to);
      const reach = clamp(span * (event.deltaY > 0 ? 1.3 : 1 / 1.3), MIN_SPAN - 1, total - 1);

      // Whatever is under the pointer stays under it, so zooming feels like
      // moving a lens rather than jumping somewhere else.
      const share = count === 1 ? 0.5 : (held - from) / span;
      let low = Math.round(held - share * reach);
      let high = Math.round(low + reach);
      if (low < 0) { high -= low; low = 0; }
      if (high > total - 1) { low -= high - (total - 1); high = total - 1; }
      low = clamp(low, 0, total - 1);

      onViewChange(low === 0 && high >= total - 1 ? null : { from: low, to: high });
    }, { passive: false });

    svg.addEventListener("dblclick", () => onViewChange(null));
  }

  host.append(svg);

  /* -------------------------------------------------------------- the foot */

  if (alive.length > 1 || axes.mode === "own" || onViewChange) {
    const foot = document.createElement("div");
    foot.className = "chart-foot";

    const keys = document.createElement("div");
    keys.className = "chart-legend";
    for (const line of alive) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = line.colour;
      // Kept short: full screen this sits in a corner panel, where a wrapped
      // line costs more room than the words are worth.
      const side = axes.mode === "own"
        ? "own scale"
        : axes.axes.length > 1
          ? (axes.axisOf(line).side === 0 ? "left" : "right")
          : null;
      const about = [line.unit, side].filter(Boolean).join(", ");
      const text = document.createElement("span");
      text.textContent = `${line.label}${about ? ` (${about})` : ""}`;
      item.append(swatch, text);
      keys.append(item);
    }
    foot.append(keys);

    if (onViewChange) {
      const hint = document.createElement("span");
      hint.className = "chart-hint";
      hint.textContent = zoomed
        ? `${ruler[0].label} to ${ruler[count - 1].label} -- ${count} of ${total}, drag to move.`
        : "Scroll to zoom in; drag to move once zoomed.";
      foot.append(hint);
      if (zoomed) foot.append(resetButton(onViewChange));
    }

    host.append(foot);
  } else if (alive[0].unit) {
    const caption = document.createElement("p");
    caption.className = "chart-unit";
    caption.textContent = alive[0].unit;
    host.append(caption);
  }
}
