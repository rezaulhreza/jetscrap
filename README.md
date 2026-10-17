# Jetscrap

A side-view 2.5D jetpack shooter for the browser. Fight AI bots on your own, or create a private room and play with friends online. The client uses Three.js. The multiplayer server is a Cloudflare Worker with one Durable Object for each room.

You can run the whole game on your own computer, or deploy it to your own Cloudflare account.

## Requirements

- Node.js 20 or later, and npm.
- For deployment only: a Cloudflare account. The free plan is enough.

## Run locally

1. Install the dependencies:

   ```sh
   npm install
   ```

2. Start the client and the game server:

   ```sh
   npm run dev
   ```

3. Open <http://localhost:5173>.

`npm run dev` starts two processes:

| Process | Port | Job |
| --- | --- | --- |
| Vite | 5173 | Serves the client with hot reload. Sends `/ws` and `/api` requests to the game server. |
| `wrangler dev` | 8787 | Runs the Worker and the room Durable Objects on your computer. |

Single player runs fully in the browser and does not use the game server. Online play needs both processes.

To try online play on one computer, open a second browser window or a private window. Choose **Play online** in both, create a room in one, and join with the room code in the other. Each tab is a separate player.

### Run the production build locally

```sh
npm run preview
```

This builds the client and serves the game and the game server together on <http://localhost:8787>, the same way that Cloudflare runs them.

To let other devices on the same network join, add `--ip 0.0.0.0`:

```sh
npm run preview -- --ip 0.0.0.0
```

Then open `http://<your-computer's-local-IP>:8787` on the other devices.

## Deploy to Cloudflare

The game deploys as one Worker. The Worker serves the built client as static assets and sends each room's WebSocket connections to that room's Durable Object.

1. Log in to Cloudflare (once):

   ```sh
   npx wrangler login
   ```

2. Build and deploy:

   ```sh
   npm run deploy
   ```

3. Open the `https://jetscrap.<your-subdomain>.workers.dev` address that Wrangler prints.

On the first deploy, Wrangler creates:

- the `jetscrap` Worker,
- the static assets from `dist/`,
- the `RoomObject` Durable Object class. It uses SQLite storage, so it works on the free plan.

The game needs no secrets, environment variables, databases or other services. All of the configuration is in `wrangler.jsonc`.

To deploy a new version, run `npm run deploy` again. Rooms that are open at that time close, and players must create a new room.

Useful commands after deployment:

| Command | What it does |
| --- | --- |
| `npx wrangler tail` | Shows live logs from the deployed Worker. |
| `npx wrangler deployments list` | Shows earlier deployments. |
| `npx wrangler delete` | Removes the Worker and its Durable Objects from your account. |

To use your own domain, add a route or custom domain to `wrangler.jsonc` (see the Cloudflare Workers documentation on routes and custom domains), then deploy again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Client and game server together, for development. |
| `npm run dev:client` | Vite only. Single player works; online play does not. |
| `npm run dev:server` | `wrangler dev` only. |
| `npm test` | Unit and simulation tests (Vitest). |
| `npm run typecheck` | TypeScript checks for the client, the shared code and the Worker. |
| `npm run build` | Type-checks, then builds the client into `dist/`. |
| `npm run preview` | Builds, then serves the production build and the game server on port 8787. |
| `npm run deploy` | Builds and deploys the Worker, the static assets and the Durable Objects to Cloudflare. |

## How to play

| Input | Action |
| --- | --- |
| `A` / `D` | Run |
| `W` or `Space` | Jump; hold in the air to fire the jetpack |
| `S` | Drop through thin platforms |
| Mouse | Aim |
| Left click | Shoot (hold for automatic fire) |
| Right click or `G` | Throw a grenade |
| `R` | Reload |
| `Q` or mouse wheel | Switch between your gun and pistol |
| `E` | Pick up the weapon you stand on |
| `Tab` | Scoreboard |
| `Esc` | Pause and settings |

The game captures the mouse (pointer lock) during a match so the sensitivity setting works. Press `Esc` to release it.

### Phones and tablets

Touch controls appear automatically on touch screens. Matches play in landscape: in portrait, a "Turn your device sideways" screen covers the game, and a solo match waits until you turn the device. On Android, the game also goes fullscreen and locks to landscape. iOS Safari does not allow a web page to lock the orientation, so turn the device by hand.

| Touch | Action |
| --- | --- |
| Left thumb | Touch anywhere on the left half and slide. Left and right run; up jumps and fires the jetpack; down drops through platforms. |
| Right thumb | Touch anywhere on the right half and slide to aim. Slide past the inner ring to shoot. |
| Grenade, Reload, Swap, Pick up | Buttons in the bottom-right corner. |
| II, Scores | Pause, and show the scoreboard. |

**Weapons:** Sparrow P9 pistol (always carried, unlimited spare ammunition), Hornet AR assault rifle (the spawn weapon), Mauler 12 shotgun, Longbow sniper rifle and Thumper RL rocket launcher. Dead players drop their gun.

**Pickups:** health (+50), armour (+50, absorbs 60% of damage), ammunition, grenades, Overdrive (50% more damage for 10 s) and Haste (speed and unlimited fuel for 10 s).

**Scoring:** a kill is +1, a suicide is -1. If you die to a hazard or your own rocket within 5 s of being hit, the last attacker gets the kill. Damage of 20 or more within 8 s of a kill earns an assist. Matches end at the time limit or the score limit.

**Maps:** Cinder Foundry (acid vats), Spirefall (rooftops over a bottomless drop) and Frostline Relay (an electrified hangar floor). All maps are symmetric so team spawns are fair.

## Architecture

```
src/
  shared/      Runs in the browser and on the server. No DOM, no Three.js.
    constants.ts   Physics, combat and timing values
    weapons.ts     Weapon definitions
    maps.ts        Map geometry, spawns, items and colour themes
    physics.ts     AABB collision, one-way platforms, ray casts
    player.ts      One player tick: movement, jetpack, weapons (used for prediction too)
    sim.ts         World: projectiles, damage, kills, pickups, match state
    bots.ts        Bot finite-state machine
    nav.ts         Grid A* navigation for bots
    protocol.ts    Network message types and compact encoding
  server/room.ts   Lobby, teams, settings and the authoritative match loop
  client/
    session.ts     LocalSession: runs World in the browser (single player)
    net.ts         NetClient (WebSocket, reconnects) and NetSession (prediction, interpolation)
    render/        Three.js scene, procedural models, effects and environments
    hud.ts, ui.ts  DOM interface
    audio.ts       Procedural Web Audio sound effects
worker/index.ts    Cloudflare Worker entry and the RoomObject Durable Object
```

### Simulation

The game runs at a fixed 60 ticks per second. `World` owns players, projectiles, pickups and the match. It records presentation events (shots, hits, kills, explosions) that the renderer, HUD and audio consume. Collision uses axis-aligned boxes: solids block from every side; one-way platforms only block from above.

### Multiplayer

- **Authoritative server.** Each room is one Durable Object. It runs the same `World` as single player. Clients send only inputs (buttons, movement direction and aim angle) with sequence numbers. The server decides movement, fire rates, ammunition, damage, deaths, pickups and scores, so a modified client cannot move faster, shoot faster or deal more damage.
- **Input validation.** Inputs are type-checked and clamped. Each player gets at most one input per tick, with a small catch-up allowance; excess inputs are dropped. Messages per second are rate-limited.
- **Snapshots** go out at 20 Hz with compact player records, pickups, grenades and rockets, scores and the events since the last snapshot.
- **Prediction.** The client runs the shared `stepPlayer` on its own inputs straight away. When a snapshot arrives it resets to the server state and replays the inputs the server has not processed yet. Small corrections blend out over a few frames.
- **Interpolation.** Other players render about 115 ms behind the newest snapshot, interpolated between snapshots.
- **Rooms.** A five-character code identifies a room. The creator is the host and controls settings and match start. If the host leaves, another player becomes host. A player who drops keeps their slot for 20 s and reconnects automatically. Bots can fill a room, and a bot gives up its place when a human joins a full match.

### Bots

Each bot is a finite-state machine with the states roam, collect, engage, hunt and retreat. Bots only know about enemies they can see (line of sight within a vision range) or hear (gunfire and jetpacks nearby). They remember a lost target for a few seconds. They path with A* over a navigation grid that prefers walking to flying, avoid hazards, detect when they are stuck, dodge incoming fire and grenades, pick up better weapons and health, and switch weapons by range.

Difficulty changes reaction time, aim error and turn speed, target leading, vision range, aggression, dodging and grenade use. It never changes bot health or damage. Each bot also gets a small random personality offset.

## Tests

```sh
npm test
```

- `test/sim.test.ts`: map sanity (spawns and items on solid ground, every spawn reachable), movement, jetpack fuel, fire rate limits, kills, assists, armour, spawn protection, team damage, kill limit, malformed input, and full 2-minute bot matches on every map and mode with a performance budget.
- `test/room.test.ts`: room creation and joining, host-only settings, team selection, an authoritative match with bots, input flooding, malformed messages, reconnection within the grace period, host hand-over, and match end with rematch.

## Settings

Volume, mouse sensitivity, graphics quality (Low turns off shadows and lowers resolution), screen shake and an FPS counter. Settings and your name are stored in this browser only.
