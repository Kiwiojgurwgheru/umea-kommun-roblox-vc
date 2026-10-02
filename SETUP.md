# Proximity voice – setup

## 1. Server (GitHub → Render)
1. Replace `server.js`, `public/index.html` and add `test/`, `roblox/`, `SETUP.md` in the repo. `package.json` is unchanged. Commit + push; Render redeploys.
2. In Render → your service → **Environment**, add:
   - `ROBLOX_API_KEY` = a long random secret (e.g. `openssl rand -hex 32`). **Required** – without it the Roblox endpoints stay disabled.
   - Optional tuning: `PROX_RADIUS` (default 60 studs), `PROX_REF_DISTANCE` (8, full volume inside), `PROX_ROLLOFF` (2), `PROX_LINK_ENTER` (1.15), `PROX_LINK_EXIT` (1.3), `PROX_TICK_MS` (100).
3. Run **one instance only** (state is kept in memory). Render's free tier sleeps when idle; the game's first request wakes it, and the script retries automatically. A paid instance avoids the wake-up delay.

## 2. Roblox Studio
1. **Game Settings → Security → Allow HTTP Requests = ON**.
2. `ServerScriptService` → new **Script** named `ProximityVoiceServer`, paste `roblox/ProximityVoiceServer.server.lua`. Set `BASE_URL` to your Render URL and `API_KEY` to the same value as `ROBLOX_API_KEY`.
   (Safer: add the key in Studio's Secrets Store as `VC_API_KEY`, allow the domain, set `USE_SECRET_STORE = true`.)
3. `StarterPlayer → StarterPlayerScripts` → new **LocalScript** named `VoiceChatNotice`, paste `roblox/VoiceChatNotice.client.lua`.
4. Publish the game. Don't make it copy-unlocked while the key is in the script.

## 3. How a player joins
1. Website: enter Roblox ID → *Join voice chat* → a 6-digit code appears.
2. In the game: type `/vc 123456` in chat. The game server reports the player's real `UserId`, so nobody can pose as someone else.
3. The website enters the room. Volume now follows in-game distance automatically.

## 4. Test with two players
Automated: `npm install && node test/two-players.js` (simulates two Roblox servers and three browsers).
Real: open the site in two browsers/devices, join the game with two accounts (Studio → Test → *Local Server*, 2 players, or the live game), verify both, then walk apart. Debug view: `GET /api/game/debug` with header `X-API-Key`.

## Notes
- Out-of-range players are not just quieter: no WebRTC link exists beyond `radius × 1.3`, signalling is refused beyond the link range, and gain is exactly 0 beyond the radius.
- Only STUN is configured. Players behind strict NATs/mobile networks may need a TURN server added to `ICE` in `index.html`.
