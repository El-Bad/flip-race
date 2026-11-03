# Flip Race

A multiplayer race game built around a "lights out" style puzzle. Everyone in a room gets the
same random board. Clicking a square flips it and the squares directly above, below, left and
right of it. The first player to turn every square green wins.

## Features

- **Rooms:** create a room or join one with a 4-letter code or invite link, and pick a name.
- **Grid sizes from 3×3 to 10×10.** Every board can be solved and needs at least 2 clicks.
- **Obstacles:** the host can add blocked squares, which can't be clicked and never flip.
- **Live race view:** each player's mini board, live clock, click count and squares left.
- **Results:** times, clicks, stars, and the fewest possible clicks shown on the starting board.
- **Solver:** appears after 30 seconds for anyone still racing.
- **Shop:** 25 board themes in four tiers (Free, Basic, Medium, Legendary), bought with stars
  earned each race. Each tier unlocks with a fast enough solve. Skin progress resets in each lobby.
- **Saved profile:** wins, losses, streaks, other stats, and your best time (and board) for each
  grid size. It is stored on the server and in the browser, encrypted with a server key so it
  can't be edited to cheat.

## Running it

Requires [Node.js](https://nodejs.org/) 18 or newer. There are no dependencies to install.

```
npm start
```

Then open http://localhost:3000. Friends on the same network can use the "On your network"
address the server prints.

## Hosting

- **Quick share from your PC:** run
  `cloudflared tunnel --url http://localhost:3000` and send friends the printed link.
- **Always-on hosting** (for example Render): use the start command `npm start`. The server reads
  the `PORT` environment variable.

Set a `PROFILE_SECRET` environment variable when hosting. Profiles are encrypted with a key
derived from it. Without it, the server creates a random key in `data/secret.key`, and if that
file is lost (as on hosts whose disk resets) every saved profile stops working.

The `data/` folder holds the secret key and saved profiles. It is excluded from git and must
never be committed.

## Files

- `server.js`: game server (rooms, boards, solver, scoring, profiles, long-polling updates)
- `public/index.html`: the whole web page (layout, themes, game logic in the browser)
