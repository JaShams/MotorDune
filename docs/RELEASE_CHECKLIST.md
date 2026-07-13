# Demolition Derby — Limited Release Checklist

This is the owner-facing sequence for publishing the existing start place
(`78681537383914`) in universe `10340853251`. Keep the experience Limited to
Playtesters until every published-client check below passes.

## Dashboard values

In Creator Dashboard / Experience Settings, set:

- **Name:** `Demolition Derby` (temporary; do not add Roblox/Blox to the final
  title).
- **Description:**

  ```text
  Smash, drift, and outdrive rivals in a power-up demolition derby inside a desert crater. Grab Bolt, Shunt, Mine, Barge, Shield, and Nitro, wreck rivals for points, and fight through fast 3-minute rounds. Jump into public matches or create a private match and invite friends with a 6-character code.

  CONTROLS
  Keyboard: WASD drive • Shift handbrake • C look back • 1/2/3 powerups • Ctrl + powerup fires backward • R flip reset
  Controller: RT accelerate • LT brake/reverse • Left stick steer/aim • A use • X/LB cycle • B handbrake • RB look back • Y flip reset • View/Select private-match menu

  Computer and console.
  ```

- **Playable devices:** Computer and Console only. Disable Phone, Tablet, and
  VR.
- **Start-place maximum players:** `8`.
- **Audience:** Limited / Playtesters; add the three tester accounts before
  sharing the experience URL.
- **Source language:** English. Disable voice and camera communication.
- **Private servers:** leave platform-level private servers disabled. The
  supported private flow is the in-game six-character reserved-server code.

## Media upload set

| Dashboard role | File | Alt text |
| --- | --- | --- |
| Icon | `marketing/icon-512.png` | Red and blue dune buggies collide in a desert crater with a cyan power-up streak. |
| Thumbnail 1 | `marketing/thumbnail-action-1920x1080.png` | A red dune buggy jumps toward a blue rival beside shield and bolt power-ups in the desert arena. |
| Thumbnail 2 | `marketing/thumbnail-arena-1920x1080.png` | Wide view of the floodlit desert crater arena with ramps, colorful power-up pads, and rival buggies. |

Use the first two generated images immediately. Add a third, authentic
1920×1080 Roblox-client capture after the three-account test; it should show
real cars and the in-game HUD, but not expose a live private code.

## Maturity, age, and regional access

Complete the Maturity & Compliance Questionnaire from the content actually in
the build:

- Violence: yes — frequent, mild, stylized vehicle combat with no people or
  blood.
- Blood/gore, fear, crude humor, strong language, romance, alcohol, gambling,
  sensitive issues, free-form creation, social hangout/private spaces, paid
  random items, and item trading: no.

The expected result is **Mild**. Review Roblox's generated preview before
submitting. In Audience > Access Settings, use the lowest age permitted by the
result and enable every region marked compliant. If the preview unexpectedly
returns Moderate, Restricted, or excluded regions, stop and audit the content
and answers before publishing.

## Published-client test record

For each entry capture tester account, device/input, timestamp, place version,
server type, screenshots, and any developer-console warnings.

1. Fresh account A joins a public server on keyboard/mouse; confirm arena
   readiness, automatic seating, drive/HUD, first pickup, first hit, reset,
   leave, and rejoin.
2. Fresh account B joins with a controller or console; confirm all controller
   bindings and private-menu navigation require no keyboard.
3. Fresh account C joins a reserved game with a valid six-character code;
   confirm rules, skin, player list, and Return to Public.
4. Join all three together; confirm unique cars/spawn slots, bot retirement,
   replicated health/slots/score, and no duplicate vehicles.
5. Test `R`/`Y` flip recovery, then Roblox Reset Character. Once Roblox has
   created the replacement character, the same owned car must reseat the player
   promptly and recover network ownership.
6. Wreck a player and confirm health/power-up reset behaviour. Test a public
   server shutdown and rejoin. Then shut down the reserved instance and reuse
   its still-valid code; also verify a bogus code fails clearly.

The clean-release test must launch from the Roblox experience detail page with
Studio and Rojo disconnected, not from Studio Play.

## Analytics verification

Published servers emit one recurring `CoreLoopEntry` funnel per player
session: `Joined → Seated → FirstPickup → FirstHit`. They also emit one
`SessionDurationSeconds` custom event at leave or server shutdown, with
`highestStep` and `serverType` fields.

Check for no `[analytics] ... failed` warnings in the published server's
developer console. After Roblox finishes aggregating data, confirm the Funnel
dashboard has all four steps and Explore shows the duration event. Studio
prints the same `[analytics]` transitions for local hook verification but does
not submit analytics data.
