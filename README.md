# Geospatial Utilities

Measure a boundary and read its climate. Drop a KML drawn in Google Earth, or
paste a location, and get the area, the perimeter and forty-five years of
daily weather for the same point.

**[Open the app →](https://k-byzid.github.io/Geospatial-Utilities/)**

Nothing to install, no account, no sign-in. Boundaries are measured on your
own device and never uploaded.

## How it works

1. **Choose a place.** Drop a KML, or paste coordinates or a Google Maps link.
   A KML with polygons in it gets measured; a single point just gets located.
2. **Map & geometry** shows the shape on a satellite map, a kilometre to every
   side, with the area in five units and the perimeter in two.
3. **Climate analysis** pulls fifteen daily parameters from NASA POWER for
   that point and charts them over whatever range you pick.

The place carries across both tabs, so choosing it again is never necessary.

## What gets measured

| Field | Meaning |
| --- | --- |
| `area_sqm` … `area_sqmi` | The same area in m², ft², acres, km² and mi². |
| `perimeter_m`, `perimeter_ft` | Distance around the ring. |
| `bounds`, `centroid` | The box the shape sits in, and its middle. |
| `coordinates` | The closed rings, WGS84 (EPSG:4326). |

Area and perimeter are computed on the sphere — spherical excess for the area,
haversine for the sides — not on a flat projection, so they hold anywhere on
Earth. The numbers match `Tools/check-pond-geometry.py` exactly.

**A file with several rings has them summed, not merged.** If a KML overlays
copies of other shapes, the total counts the shared ground once per copy. The
per-ring table under the map is what to read in that case. Overlapping rings
are drawn as thin, low-opacity overlays so the stack stays legible.

## Climate

Fifteen daily parameters from [NASA POWER](https://power.larc.nasa.gov/),
available worldwide from 1981 to about three days ago:

| Group | Parameters |
| --- | --- |
| Temperature | mean, max, min, diurnal range, earth skin, dew point |
| Water | precipitation, relative humidity, evapotranspiration, land evaporation |
| Sky | solar irradiance, photosynthetically active radiation, cloud amount |
| Air | wind speed at 2 m, surface pressure |

Pick a range, average by day, month or year, and click any parameter to plot
it. Parameters sharing a unit can be plotted together; picking one with a
different unit starts a fresh chart, because two units cannot be read off one
axis.

**Precipitation and land evaporation are totalled over each bucket; everything
else is averaged.** A month of rainfall is a depth that accumulated, so summing
it is the meaningful figure. A month of humidity is not.

Missing readings — POWER's `-999` — are left as gaps rather than zeros, so
they never drag an average down. The summary table counts them per parameter,
and the chart breaks the line rather than drawing through them.

`Download CSV` saves exactly what is on screen, at the chosen averaging.

## Coordinate formats

| You paste | Read as |
| --- | --- |
| `23.5275, 90.8431` | latitude, longitude |
| `90.8431°E, 23.5286°N` | either order — the hemisphere letter decides |
| `2.154°S, 79.9224°W` | southern and western hemispheres |
| `google.com/maps/...` | the pinned place, else the search, else the camera |

A shortened `maps.app.goo.gl` link **cannot** be read. It carries no
coordinates of its own — they are only in the address it redirects to, and a
web page is not allowed to see where a cross-origin redirect landed. Open the
link, then paste the address bar back here; that URL is in a form the app
reads. The alternative would be bouncing your link off someone else's server,
which this app does not do.

## Privacy

Everything except the climate lookup happens in your browser. The KML is read
locally, the geometry is computed locally, and nothing about the shape is sent
anywhere. The single outbound request is to NASA POWER, for the coordinates of
the point you chose, and only when you press **Load climate**.

Map tiles come from OpenStreetMap and Esri, which necessarily see the tiles
your browser asks for.

## Development

No build step and no dependencies. The geometry, the KML and coordinate
parsing, the NASA POWER client and the chart are each their own module in
`assets/`, and only `app.js` touches the page.

```bash
node --test tests/*.mjs     # geometry, parsing, climate
```

PowerShell does not expand the glob; there, name the files:

```powershell
node --test tests/geometry.test.mjs tests/parse.test.mjs tests/climate.test.mjs
```

The tests cover the pure modules. `ringsFromKml` is left to the browser, since
it leans on `DOMParser`, which Node has no equivalent of.

Serve the directory over HTTP to run it locally; opening `index.html` from the
filesystem will not work, as ES modules need a real origin.

```bash
python -m http.server 8000
```

To check the port against the Python tool this was derived from:

```bash
python ../Tools/check-pond-geometry.py "../Metadata/Pond Coordinates/Pond-Main.kml"
```

### Deploying

It is a static site — push it and turn on GitHub Pages for the branch root.
There is nothing to build.

## Licence

MIT — see [LICENSE](LICENSE).
