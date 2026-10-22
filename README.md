# THE SILENT MERIDIAN

> Tactical security simulation · Operation 01 "SILENT BERTH"
> 23:41. Sea fog has sealed Berth 3 at Meridian Port. You lead a four-person security team into the warehouse district to handle armed suspects, protect civilians, recover the cargo manifest, and gather evidence from the dispatch office.
> **Observe first. Then give the order.**

[![Play online](https://img.shields.io/badge/play%20online-GitHub%20Pages-54d6c6?style=flat-square)](https://sun-sh902.github.io/Silent-Meridian/)
[![Tests](https://img.shields.io/badge/tests-11%2F11%20pass-54d6c6?style=flat-square)](#self-checks)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-three.js%20only-brightgreen?style=flat-square)](#threejs-has-exactly-one-runtime)

A purely client-side, offline-capable first-person tactical simulation: **zero runtime dependencies** (Three.js is vendored locally), no network requests of any kind, and every texture and sound generated procedurally at runtime with canvas / WebAudio.
One command runs all 11 real-Chrome acceptance suites.

[Play online](https://sun-sh902.github.io/Silent-Meridian/) ·
[Run locally](#getting-started-important) ·
[Controls](#controls) ·
[Self-checks](#self-checks)

<img src="docs/shots/04-yard.png" alt="Port operation: first-person view, HUD objective list, four-person squad status and command bar" width="100%">

<details>
<summary><b>More screenshots</b> (main menu / briefing / loadout / tactical map / debrief)</summary>

| Main menu | Operation briefing |
| --- | --- |
| ![Main menu](docs/shots/01-title.png) | ![Operation briefing](docs/shots/02-briefing.png) |

| Loadout | Tactical map (Tab) |
| --- | --- |
| ![Loadout](docs/shots/03-loadout.png) | ![Tactical map](docs/shots/05-tacmap.png) |

![Debrief](docs/shots/06-debrief.png)

Every screenshot is captured by actually running the game via `node tools/readme-shots.mjs` — none are hand-drawn mockups.

</details>

### What this is

A **completable mission level**, not a tech demo: enter the port, observe and identify, issue squad orders, detain suspects, escort civilians, recover intelligence, and extract — then receive an action rating and a per-item breakdown.

A few constraints that set it apart from other practice projects:

| Constraint | How it is met |
| --- | --- |
| Runs offline | No `fetch` / `Worker` / dynamic `import()` / CDN; Three.js is vendored locally |
| Zero external visual assets | Textures, signage, sky and water are all generated procedurally (`src/textures.js`) |
| Zero external audio assets | WebAudio synthesizes gunshots, echoes and tinnitus (`src/audio.js`) |
| Verifiable | 11 Puppeteer suites run real Chrome; any page error counts as a failure |
| Feel can be regression-tested | Parameters live in `src/feel.js`; baseline diffs catch behavioral drift |

---

## Getting started (important)

### Option A: Local server (recommended; the full development mode for `index.html`)

`index.html` and `src/*.js` are **ES modules**. Under `file://`, the browser blocks the entire module graph with its CORS policy (`Access to script at 'file://…/src/main.js' from origin 'null' has been blocked by CORS policy`), so **not a single line of JS runs** — the page is styled, but every button is dead.
You therefore have to open it over HTTP:

```bash
git clone https://github.com/Sun-sh902/silent-meridian.git
cd silent-meridian
npm start                  # starts a local server and prints the address; zero deps (Node built-ins only)
```

The equivalent manual route (if you don't want to install Node):

```bash
python3 -m http.server 8123
```

> On macOS you can also double-click `start.command`; it changes into its own directory before starting the server.

Then open:

```
http://localhost:8123/
```

(You can change the port: `npm start -- --port 9000`, or edit the command — the address follows.)

### Option B: No server, just double-click

Double-click either of these files; neither needs a local server and both run fine under `file://`:

| File | Notes |
| --- | --- |
| `dist/silent-meridian.html` | Single-file build: JS / CSS / textures all inlined, one file only |
| `index.html` | Detects `file://` and switches to loading `dist/silent-meridian.js` (a **classic script**, exempt from module CORS) |

> Option B relies on `dist/` already existing and **not being stale**. If you have changed `src/` or deleted `dist/`, run `node build.mjs` once to regenerate it. If `dist/silent-meridian.js` is missing, the page shows a prompt telling you that exact command.
>
> ⚠️ **After changing `src/`, always rebuild before verifying Option B.** A stale bundle and a fresh bundle carry the same version number, so the difference is invisible to the eye; `npm test` first runs `tools/check-dist.mjs`, which catches it via content hash (see "Self-checks" below).

> This repository **commits `dist/` directly** (about 1.4 MB): clone it and you can double-click and play without installing dependencies or building first.
> The trade-off is that any change to `src/` must be rebuilt and committed, or the bundle in the repo goes stale —
> the first item in `npm test`, `check-dist`, uses content hashes specifically to catch that (see "Self-checks" below).

### Rebuilding

```bash
node build.mjs
# → dist/silent-meridian.js   (classic script, loadable under file://; header carries vX.Y.Z + content hash)
# → dist/silent-meridian.html (single file)
# → dist/build-stamp.json     (input fingerprint for this build; lets check-dist detect staleness)
```

### Why there are two loading paths

| How it is opened | What gets loaded | Does it run? |
| --- | --- | --- |
| `http://localhost:8123/` | `src/main.js` (`type="module"` + import map + 19 source files, 51 `import` statements) | ✅ |
| `file:///…/index.html` | The bootstrap script detects `file:`, then loads `dist/silent-meridian.js` (IIFE classic script) instead | ✅ |
| `file:///…/index.html` (no dist) | Load fails → page shows the command prompt + debug panel turns red | ⚠️ Explicit warning, no longer "silently does nothing" |

There is no `fetch` / `Worker` / dynamic `import()` / network resource anywhere in the code, and every texture is generated in-browser by canvas, so once bundled as a classic script it runs fully under `file://`.

---

## Debug panel (finding out whether the script actually ran)

Press **`D`** to bring it up (main menu / briefing / loadout / debrief / **pause menu**). **During an operation `D` belongs to the game (strafe right)**, so use **`~`** (backtick) to toggle the panel there.
The panel always shows:

* **Script executed** — when the bootstrap script ran (the bootstrap is an inline classic script, so it always runs)
* **How it was opened** — `http:` / `file:` and the loader actually used
* **Main script** — ✓ loaded / ✗ failed to load
* **Action handlers** — ✓ registered (lists every action) / ✗ not registered (meaning the game script never ran)
* **Page buttons** — the number of `[data-action]` elements currently in the DOM
* **Pointer lock** — while locked, press `Alt` before clicking a button
* **Most recent click event** — time / tag / action name, to confirm clicks actually arrive

---

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` / `Ctrl` | Sprint / sneak |
| Mouse | Look around (click the view to lock the pointer) |
| Right mouse | Aim down sights (faster observation, tighter spread) |
| Left mouse | Fire |
| `R` | Reload |
| `G` | Throw tactical gadget (hold to charge) |
| `F` | Tactical light toggle (sees farther, but easier to spot) |
| `E` | Interact: recover item / escort civilian / detain suspect / treat teammate |
| Space (hold) | Tactical pause: time slows to 10%, for observing and issuing orders |
| `1` | Formation follow — FOLLOW |
| `2` | Hold position — HOLD |
| `3` | Move and clear — CLEAR (advance to the crosshair point) |
| `4` | Regroup — REGROUP |
| `Tab` | Tactical map (left-click places a squad waypoint / right-click places an attention marker) |
| `Alt` | Release the mouse (cursor mode): click HUD command buttons; click the view to restore look control |
| `Esc` | Pause menu |
| `M` | Mute |

> The interface reflows automatically with window size and browser zoom, with no squeezing or overlap. Press `D` to open the debug panel and inspect the current viewport info
> (main menu / briefing / loadout / debrief / pause menu only; **during an operation `D` is strafe right**, so use `~`).
> The debug panel's "build tag" row shows the current bundle's version and content hash, and turns red if the version does not match the page.

---

## Feel tuning hub and tuning panel (batch 1)

Every feel number lives in **`src/feel.js`**; logic code reads that object every frame and never caches it at construction time — change a value and it takes effect immediately.

| Group | Contents |
| --- | --- |
| `move` | Walk / run / crouch / ADS speeds, stamina, acceleration / deceleration / glide durations, diagonal normalization, turn damping |
| `jump` | Jump parameters (**fully disabled** this round, all values 0; the `onLanding` hook is reserved) |
| `camera` | Default / sprint / ADS field of view, sensitivity and ADS sensitivity multiplier, head-bob amplitude and **toggle**, camera roll |
| `weapon` | Vertical recoil kick, recovery speed, horizontal jitter, recoil→aim conversion rate, deterministic recoil pattern toggle |
| `spread` | Base / moving / sprinting / burst spread, spread recovery speed, recoil and suppression contributions to spread |
| `feedback` | Hitmarker duration, hit-stop, damage numbers, screen-shake strength and decay, muzzle-flash duration, shell-ejection speed |
| `reload` | Weapon-switch duration, ADS in/out rates, reload duration scale, interruptible reload |
| `viewmodel` | First-person weapon bob / drag / recoil kick (inertial carrier; by convention the crosshair stays 1:1 with no lag) |

> `TUNING` in `data.js` (AI / identification parameters) **is deliberately left untouched** by convention and does not belong to this file.

### Tuning panel

| Key | Action |
| --- | --- |
| `P` | Full panel: bottom drawer (keeps roughly the top third of the view), **releases the pointer, keeps time at 100%, and WASD still moves** |
| `O` | Read-only overlay: **does not release the pointer**; shows four live curves and values |
| `[` `]` | In overlay mode, decrease / increase the selected parameter |
| `,` `.` | In overlay mode, cycle the selected parameter |

The panel provides **Export JSON** + **Copy to clipboard**, **3 preset slots** (slot A is fixed to "Original (pre-change)" for A/B comparison), **Freeze enemy AI**, **Invincible**, **head-bob toggle**, and **Reset curves**.
Parameters tagged `not wired` belong to batches 2/3; dragging them currently changes nothing (to avoid misleading you).

The four curves come from the `feel.js` `telemetry` ring buffer (preallocated, zero GC): speed, acceleration, recoil, spread.

### Feel regression baseline (proving batch 1 changes no behavior)

```bash
node tools/feel-baseline.mjs compare tools/feel-baseline.json
```

Drives `game.advance()` at a **fixed 1/60 s timestep** (`?test=1` freezes rAF), masking frame-rate jitter and rendering differences, so results are bit-for-bit reproducible. The comparison covers: steady-state speed and FOV in all four stances, acceleration / release ramps, camera roll and head bob, first and last burst-spread values, per-shot recoil accumulation and recovery, reload / weapon-switch / ADS durations, the shake envelope, and muzzle-flash duration.

> Baseline runs must happen on the same machine; a different GPU or browser version does not affect this script (it only runs the simulation and does not depend on rendering).

### Fixed: doubled fire rate and halved blind duration

`player.update()` first calls `updateCommon(dt)` (which already does `fireCd -= dt`), then decremented it again on its own, so `fireCd` fell by 2×dt per frame:

* The MR-4, rated at 640 rpm, measured one shot every 3 frames (≈1200 rpm) — **fixed**, now one shot every 6 frames;
* The same bug decremented `blind` twice as well, halving flashbang blind duration (2.5–7 s became 1.25–3.5 s) — **fixed**.

After the fix the baseline uses the new values: `spread.shots` went from 30 to **15** (90 frames at a fixed 1/60 s timestep).
The theoretical value is 16 shots (1.5 s × 640 rpm ÷ 60); the measured 15 comes from the shot interval being quantized to whole frames:
640 rpm ⇒ 5.625 frames, rounded up to 6 frames ⇒ effective 600 rpm.
This is the inherent quantization error of per-frame decrementing, and it **varies with refresh rate** (617 rpm at 144 Hz).
To align exactly with the rated rate, change `this.fireCd = rate` to `this.fireCd += rate` so the remainder carries over; that is a separate issue and has not been changed yet.

> After changing `feel.js` or anything else that affects feel, remember to resample the baseline:
> `node tools/feel-baseline.mjs capture tools/feel-baseline.json`

## Responsive layout and scaling

* **Typography**: everything goes through `--fs-*` tokens, all written as `max(Nrem, 12px)` — **never smaller than 12 px** under any circumstances.
* **Sizing**: width and height use `clamp()` / `rem` / `vmin`, spacing uses `--pad-*`; the root font size `clamp(15px,…,18px)` scales gently with the viewport.
* **Layout**: the HUD is a `grid` (three rows × three columns); every panel participates in layout and reflows at breakpoints.
  Only the "full-screen effect layers" and the "crosshair cluster" stay absolutely positioned — the latter must be pinned to the exact viewport center to match the aim ray.
* **Breakpoints**: `≥1920` / `≤1439` / `≤1023` / `≤767` / `≤480`, plus **short-window compression tiers** at `≤760px`, `≤620px`, `≤520px`, `≤440px`.
  On narrow screens, secondary elements (minimap, radio, hint bar, compass) are hidden before text is compressed.
* **Canvas**: `ResizeObserver` watches the container and `matchMedia('(resolution: Ndppx)')` watches DPR changes, so the backing store always equals `CSS size × devicePixelRatio` (capped at 2) — no blurring or distortion after browser zoom.
* **Overflow prevention**: `html/body/#app/#hud` are all `overflow:hidden`, so no horizontal scrollbar appears.

### Responsive acceptance test

```bash
node tools/responsive-test.mjs
```

Four scan segments, **38 audits** in total:

* Segment A: 8 widths (1920 / 1440 / 1280 / 1024 / 900 / 768 / 600 / 480)
* Segment B: 5 browser zoom levels (50% / 75% / 100% / 125% / 150%, physical window 1440×900)
* Segment C: 4 screens (title / briefing / loadout / help) × 5 widths
* Segment D: debrief panel × 5 widths

Per-item assertions:
no horizontal scrollbar, no pairwise overlap of key panels, no text overflow or clipping, font size ≥ 12 px, and canvas backing store equal to `CSS size × DPR` with unchanged aspect ratio.

> **Why is Alt needed?** During an operation the browser is in pointer lock, so every mouse click is delivered to the 3D view
> and the HUD buttons receive nothing. Press `Alt` to release the pointer, then click the command buttons normally;
> time drops to 30% so you can act deliberately. Click anywhere in the view to return to mouse look.
> The command buttons' keyboard shortcuts `1` `2` `3` `4` work in any state.

---

## Core mechanics

### Friendly fire and target identification

* **Friendly fire is off**: the player and the four teammates are all on the blue team, and bullets **pass straight through** friendlies without causing damage
  (there is an additional backstop at the damage entry point). Shots still hit enemies behind a teammate.
* **Civilians can still be hit by mistake** — that is a mission-failure condition; the rules of engagement have not been softened.
* When the crosshair is on a teammate, the target card shows their **callsign and specialty** instead of `UNKNOWN CONTACT`.

### Tactical map colors

| Marker | Meaning |
| --- | --- |
| 🔵 Blue arrow | Player and teammates (the player has a white outline for easy identification) |
| 🟠 Orange dot | Identified enemy (surrendered / detained shown as a hollow ring) |
| 🟡 Yellow dot | Event: gunfire / alarm / explosion / intel recovery / casualty / civilian found |
| 🟢 Green square | Civilian |
| 🔶 Amber diamond | Objective point |
| ⚪ Grey `?` | Unidentified contact (preserving the core "observe first, then order" mechanic) |

Event dots fade after about 2 minutes and show a text label for the most recent 15 seconds.

### Coordinate conventions for the two maps (corrected)

| | Minimap `#minimap` | Tactical map `#tacmap-canvas` |
| --- | --- | --- |
| Mode | **Player faces up** (rotates with heading) | **North up, fixed** (world-fixed) |
| Transform | Translate(−player) → rotate around player by **+yaw** → scale k → translate to canvas center | Translate(−bounds) → uniform scale → center |
| Rotation center | **The player's own position** (not the canvas origin) | No rotation |
| Angles | All radians; recomputed every frame from absolute `p.yaw`, no accumulator | Same |

> ⚠️ **This project's sign convention for yaw**: `player.look()` uses `yaw -= dx * sens`,
> so **turning the mouse right → yaw decreases**, turning left → yaw increases. This is the opposite of the intuitive "increasing yaw = turning right";
> keep it in mind when changing map-orientation code.

### `window.__mapDebug` debug interface

```js
__mapDebug.mode              // 'minimap=player-up(rotating) / tacmap=north-up(fixed)'
__mapDebug.player            // { x, y, yaw }   ← y is the world z coordinate
__mapDebug.yawRad / yawDeg   // current heading
__mapDebug.buildings         // [{ name, x, y }]
__mapDebug.worldToMap(x, z)  // world → minimap pixels (also accepts {x,z}; rotated, player-up)
__mapDebug.worldToMapTac(x, z) // world → tactical map pixels (north-up)
__mapDebug.mapToWorld(mx, my)  // minimap pixels → world
__mapDebug.labels / labelsMini // { stats:{total,drawn,rejected,offscreen}, items:[…] }
```

### Map label rules

* Text is **always drawn horizontally** and never rotates; the anchor point rotates, not the glyphs.
* Font size is fixed in design pixels; because `render()` already does `setTransform(dpr,…)`, labels do not shrink on HiDPI and are not stretched by map zoom.
* **Collision avoidance**: candidate labels are sorted by "priority + distance to player" and placed one by one; overlapping ones are hidden outright (`stats.rejected` reports them).
* Anything outside the visible area is skipped; large nearby areas take priority.
* Every label gets a dark translucent backing so it stays readable on both bright and dark backgrounds.

### Observe first, then give the order

In the sea fog you cannot tell a civilian from a gunman by silhouette. Put the crosshair on a target and a target card plus an identification progress bar appears in the center of the screen:

* `UNKNOWN CONTACT` — you only know something is moving there;
* `PERSONNEL CONTACT · UNIDENTIFIED` — detected, not confirmed;
* `ARMED SUSPECT` / `CIVILIAN · NON-COMBATANT` — identification complete.

Firing before identification is logged as a "blind shot" and directly deducts from the operation score; hitting a civilian immediately fails the operation.
Hold Space to enter tactical pause and complete identification and issue orders without taking risks.

### Three squad orders

* Formation follow — the four move with the team leader in wedge formation, automatically routing around obstacles.
* Hold position — the squad stops and watches its current facing; facing is taken from the team leader's view direction at the moment the order is given.
* Move and clear — the squad splits into two fire teams and advances to the waypoint by bounding overwatch:
  one team bounds while the other stops to cover.

By default the squad observes fire discipline: it fires only after receiving "move and clear" or after taking fire; otherwise it only reports.
If you issue an order while looking directly at a squad member, the order goes only to that member.

### Tactical map (Tab)

A top-down plan of the port showing the squad, identified targets, objective points, and the last known sighting.
Left-click places a waypoint and issues "move and clear"; right-click places an attention marker; double-click clears them.

---

## Mission objectives

| Objective | Description |
| --- | --- |
| Recover the cargo manifest | Documents in the BAY 3 office |
| Gather evidence from the dispatch office | Surveillance and registration records in the port dispatch building |
| Protect civilians | Find the night-shift workers and escort them (`E`) to the south gate rally point |
| Handle armed suspects (secondary) | Detention is better than killing: persuade them to surrender, then approach and press `E` to detain |
| Extract from the port | Once the three primary objectives are complete, the south gate armored vehicle opens up |

---

## Engineering structure

```
index.html            Page skeleton and all interface DOM
styles/ui.css         Interface styles (HUD / briefing / loadout / map / debrief)
src/main.js           Bootstrap and debug parameters
src/game.js           Mission orchestration: order system, identification, objective flow, main loop
src/world.js          Original port layout, lighting, sea fog, environment map
src/actors.js         Character models, squad / suspect / civilian AI
src/player.js         Team leader controller
src/combat.js         Ballistics, hit resolution, projectiles, effects
src/nav.js            Navigation grid and A* pathfinding
src/geom.js           Math, spatial grid, line of sight, collision
src/viewmodel.js      First-person weapon and pose
src/hud.js            Heads-up display
src/tacmap.js         Tactical map
src/screens.js        Main menu / briefing / loadout / debrief panels
src/textures.js       Procedural textures and fictional signage
src/audio.js          WebAudio procedural sound effects
src/feel.js           Feel parameter hub (single source of truth) + live telemetry ring buffer
src/tuning.js         Tuning panel (summoned with P / O)
src/canvasfit.js      Canvas sizing and DPR adaptation (ResizeObserver + matchMedia)
src/maplabel.js       Map label avoidance (object pool + width cache)
vendor/three.module.js  Three.js runtime (vendored locally, works offline)
vendor/three.core.js    Three.js runtime core (imported by the line above)
tools/                11 Puppeteer acceptance suites + perf/feel baselines + screenshot script
docs/shots/           README screenshots (generated by tools/readme-shots.mjs)
dist/                 Build output (committed: double-click and play)
```

### Tech stack

No framework, no toolchain beyond the bundler, no CI service dependency:

| Layer | What is used | Notes |
| --- | --- | --- |
| Rendering | Three.js `0.180.0` (vendored locally) | The only runtime dependency; 7 files under `src/` bare-import `three` |
| Interface | Native DOM + one `styles/ui.css` | No framework, no virtual DOM; HUD updates are optimized for per-frame cost |
| Logic | Native ES modules | 19 source files, 51 `import` statements, runs directly in the browser with no compile step |
| Assets | None | Textures and sounds are all generated procedurally; the repository contains not one art asset file |
| Build | esbuild (devDependency only) | Used solely to produce `file://`-compatible `dist/*` |
| Testing | puppeteer-core + local Chrome | 11 suites; page errors, `console.error` and resource failures are always FAIL |

### Three.js has exactly one runtime

All 7 files under `src/` use the bare specifier `import ... from 'three'`, which has two resolution paths:

| Path | Resolves to | Used by |
| --- | --- | --- |
| Development (http) | `index.html`'s import map → `vendor/three.module.js` | normal `npm start` browsing |
| Bundle (file://) | esbuild `--alias:three=./vendor/three.module.js` | `dist/*` |

`build.mjs` adds the alias explicitly, pinning the bundle path to `vendor/` as well, **so the two copies cannot diverge**.
`three` in `package.json` is also pinned to the exact version `0.180.0` (it used to be `^0.180.0`),
purely for editor/toolchain type resolution; it does not participate in bundling.

## Debug parameters

Append query parameters to the URL for easier verification:

`?deploy=1` drop straight into the operation · `&pos=x,z` set the spawn point · `&yaw=radians` set the heading
`&alarm=1` raise the alarm immediately · `&dummy=8` place stationary targets directly ahead
`&tacmap=1` open the tactical map · `&screen=briefing|loadout` open the specified screen
`&debrief=1` view a sample debrief panel · `&novm=1` hide the first-person weapon

## Self-checks

### Run every acceptance suite with one command

```bash
npm test            # = node tools/run-all.mjs; 11 suites, per-suite exit codes summarized
```

Suite overview (`npm run test:<name>` runs one individually):

| Suite | Purpose |
| --- | --- |
| `test:dist` | dist/ staleness check (content hash, no browser needed) |
| `test:click` | Full click paths across all interfaces under three ways of opening the game |
| `test:fixes` | Loadout silence / target card / friendly fire / map colors |
| `test:p0` | Reproduction and regression of four P0 defects (including `?deploy=1&test=1` fixed-timestep driving) |
| `test:p1` | Fire rate and blind duration, diagonal speed, AI cover deadlock, frame-rate independence, mission timers, identification time base, AI burst fire |
| `test:map` | Minimap / tactical map coordinates and markers |
| `test:tuning` | Tuning panel: sliders reconciled item-by-item with `FEEL_SCHEMA`, export/copy paths |
| `test:responsive` | 8 widths × 5 zoom levels × per-screen layout audit |
| `test:audio` | 20-flashbang stress test compared against a control group |
| `test:feel` | Bit-for-bit feel-baseline comparison |
| `test:selftest` | Injects an uncaught exception to prove the test harness really does turn red |

### dist/ staleness check (no browser needed, takes seconds)

```bash
node tools/check-dist.mjs
```

`dist/` is committed with the repository, and `index.html` loads exactly `dist/silent-meridian.js` under `file://`.
**If you change `src/` and forget to rebuild, people who double-click will keep running the old bundle — and the old and fresh bundles have identical version numbers, so nothing is visible from the outside.**
This script compares the content hashes of the input files (`src/**/*.js`, `index.html`, `styles/ui.css`, recorded in `dist/build-stamp.json`) against their current values, item by item; any file changed after the build makes it FAIL and lists the filename:

```
[FAIL] dist is not stale (src / index.html / ui.css unchanged since the build)  —  changed: src/game.js — Run: node build.mjs
```

It uses content hashes rather than mtime, so `git clone` / checkout order cannot affect it.
There is another runtime backstop: the debug panel's "build tag" shows the version and hash embedded in the bundle,
and turns red when they disagree with the page version (same-version content staleness cannot be detected at runtime; this script covers that case).

### Performance and resource probe (comparable quantitative baseline)

```bash
npm run perf                              # print current metrics
npm run perf:save                         # save as tools/perf-baseline.json
npm run perf:diff                         # compare with the baseline; non-zero exit if clearly worse
```

It reports per-frame DOM mutations, layout reads, logic time, and GPU resource growth across repeated deployments.
It is **not** a pass/fail test but a ruler — proof that an optimization really worked, rather than a feeling.

Each item is judged with a "which direction is better": more FBO deletions is better, fewer of everything else is better;
logic time samples few frames under swiftshader and is noisy, so it is informational only and does not count toward failure.
Deployment growth uses the "difference between adjacent deployments" to measure steady-state leaks, avoiding counting one-time first-deployment initialization as a per-deployment leak.

### Logic throughput benchmark (low variance, suitable for A/B)

```bash
npm run bench                             # print results
npm run bench:save                        # save as tools/perf-bench.json
npm run bench:diff                        # compare with the baseline; non-zero exit if clearly worse
```

`perf-probe` measures "steady-state cost"; `perf-bench` measures "pure logic throughput + draw calls".
The latter freezes rAF with `?test=1` and drives `advance()` manually at a fixed timestep, so it is almost immune to software-rasterization
noise — that is the key to a trustworthy A/B comparison. Each scenario runs 7 rounds and takes the median.

> Two easy traps (already handled and commented in the tools):
> 1. `Game.loop()` calls `renderer.render()` **twice** per frame (main scene + viewmodel's private scene),
>    and `info.autoReset` is true — the second call zeroes the counters, so reading `info.render.calls` directly
>    gives you the dozen-odd draw calls of the "weapon" and completely misses the level. You must wrap render
>    and sample only after the main-scene call.
> 2. The logic benchmark teleports actors to 999 (far beyond `far=420`); if you then measure rendering straight away,
>    the entire scene is frustum-culled and you get empty-scene numbers only. You must redeploy first, then scan view angles.

> Measured results from this project's P2/P3 rounds (same machine, HEAD before/after, 900 fixed steps, median of 7 rounds):
>
> Method: run the baseline and the optimization **twice each, interleaved**, and take the best of each to cancel machine drift.
> Before hardening, rerunning the same code in a fresh process varied by about ±15%; with "one warm-up round + best of 9 rounds" it converged to about ±5%.
>
> | Scenario | Before | After | Change |
> | --- | --- | --- | --- |
> | Logic idle-follow | 118.3 ms | **28.6 ms** | **-75.8%** |
> | Logic clear-order | 121.5 ms | **30.6 ms** | **-74.8%** |
> | Logic engage-9 (9-person firefight) | 141.3 ms | **52.2 ms** | **-63.1%** |
> | Logic squad-firing | 118.0 ms | **35.8 ms** | **-69.7%** |
> | **of which HUD timed separately** | **100.7 ms** | **21.2 ms** | **-78.9%** |
> | Main-scene draw calls (median) | 119 | **98** | -17.6% |
> | Main-scene draw calls (peak) | 275 | **254** | -7.6% |
> | geometries | 492 | **425** | -13.6% |
> | triangles (median) | 11992 | 12996 | +8.4% (trade-off with draw calls; informational only) |
>
> About 8–10 percentage points of that came from **removing the rain curtain**: 5,200 rain-streak particles with a hand-written shader,
> an entire full-screen CSS rain compositing layer, and lightning ambient light are no longer needed.
> | Per-frame DOM mutations (perf-probe) | 27.3 | **2.6** | -90% |
> | Per-frame layout reads (perf-probe) | 55.2 | **3** | -95% |
> | Net texture growth per redeployment | +8 | **0** | constant 37 across 10 deployments |
> | Net geometry growth per redeployment | +24.6 | **0** | fluctuates 398–423, no upward trend |
>
> **Attribution**: before optimization, `hud-update-only` (100.7 ms) accounted for about **85%** of `idle-follow` (118.3 ms) —
> per-frame HUD DOM/layout cost was by far the largest logic cost at the time. Once that was squeezed down to 21.2 ms,
> the remaining ~7 ms was the actual game logic.
>
> **The rise in triangles is an accepted trade-off**: merging 46 puddles into 1 mesh gives up per-object frustum culling,
> so up to 644 triangles are submitted every frame; in exchange, up to 46 transparent draw calls drop to 1.
> Draw calls are the scarce resource (each carries state validation and uniform upload overhead),
> while a few hundred triangles per frame is negligible for any GPU.

### Click-path self-check

Runs every interface button's click path in real Chrome (not the preview pane), covering three ways of opening the game:

* `http://localhost` server mode
* `file://` opening `dist/silent-meridian.html` directly (single file)
* `file://` opening `index.html` directly (automatic fallback to the classic script)

```bash
node build.mjs && node tools/click-test.mjs
```

Verifies item by item: menu navigation, loadout selection, deployment, HUD command buttons, tactical-map placement, pause/resume/abort,
debug-panel contents, and uses `elementFromPoint` to check that a button really receives its own click (anything occluded is an immediate FAIL).

> The Chrome executable is no longer hardcoded: it prefers the `CHROME_PATH` environment variable, otherwise probes the usual
> macOS / Linux / Windows locations in order; if none is found it exits with code 2 and prints the paths it tried (no stack trace).
> Page uncaught exceptions, `console.error`, and resource-load failures all count as failures and affect the exit code —
> `tools/selftest-red.mjs` injects an uncaught exception to prove this path really does turn the tests red.

### Audio / flashbang stress test

```bash
node tools/audio-stress.mjs
```

Triggers 20 flashbangs in a row and compares against a control group that "throws nothing", verifying:

* exactly **20** detonations (preventing regressions such as "detonating again every frame")
* main-thread per-frame logic time (excluding rendering) averaging < 16 ms, peaking < 50 ms
* the `AudioContext` count stays at 1, and audio nodes fall back after use
* projectiles / DOM log / whiteout layer are all reclaimed, with no uncaught exceptions

### README screenshots

```bash
node tools/readme-shots.mjs        # → docs/shots/*.png (really drives the interface in local Chrome)
```

Follows the user path through main menu → briefing → loadout → deployment → tactical map → debrief, taking a screenshot at each screen;
each step asserts that the target screen actually appeared, failing with a non-zero exit code if it did not (so it cannot produce a "blank screenshot" and call it success).
It is **not part of `npm test`**: this is a manual workflow and should not rewrite repository files on every regression run.

---

## Audio implementation constraints (why it can no longer freeze or crackle)

| Constraint | Implementation |
| --- | --- |
| One global `AudioContext` (module-level singleton, never `new` a second one) | `src/audio.js` `acquireContext()` |
| Each voice `disconnect()`s in `onended` after `stop()` and releases its references | `src/audio.js` `_v()` |
| At most 40 simultaneous voices; excess is dropped to avoid an avalanche | `src/audio.js` `_budget()` |
| Minimum interval per sound (150 ms for flashbangs) prevents stacking into a screech | `src/audio.js` `_gate()` |
| White-noise buffer: generated once + asynchronously in 16,384-sample chunks | `src/audio.js` `_buildNoiseBuffer()` |
| Every gain change ramps over ≥5 ms; instantaneous assignment is forbidden (including mute) | `src/audio.js` `_env()` / `setMuted()` |
| End of the output chain uses a `DynamicsCompressor` limiter + output gain 0.8 | `src/audio.js` `init()` |
| Tinnitus tone at 2.2 kHz + low-pass softening + volume 0.028 (not piercing on headphones) | `src/audio.js` `flashbang()` |
| The blinding whiteout uses only a CSS opacity transition, with zero per-pixel work | `src/hud.js` `flash()` |

---

## Open source and deployment

* **License**: [MIT](LICENSE) — free to use, modify, distribute and use commercially, provided the copyright notice is retained.
* **Play online**: GitHub Pages serves the repository root directly (`index.html` is the entry point;
  `src/` loads normally as ES modules, with no build step required).
* **Purely static**: there is not a single backend endpoint; the whole site can be dropped onto any static host (Vercel / Netlify / Cloudflare
  Pages / object storage); the single-file `dist/silent-meridian.html` is especially convenient for direct distribution.
* **Want to modify the code**: `npm install` → start the local server → edit `src/` → `npm test` → `node build.mjs`.
  If you change behavior, add an assertion while you are at it; the suites in `tools/` are written around "page errors count as failures".

### Contributing and feedback

Issues / PRs are welcome. Before submitting, make sure `npm test` passes 11/11 and that you have
rerun `node build.mjs` whenever `src/` changed (otherwise `check-dist` turns red).

---

The port district, organizations, brands, ship names and personnel in this work are fictional creations, unrelated to any real company, institution or person.
