# Simple Auction House

A player-to-player auction house for Minecraft Bedrock, as a behavior pack plus a resource pack.
Players list the item they're holding for a price, and others browse and buy from a chest-style
menu. Money is a scoreboard, so it works with any economy that uses one.

Runs on Bedrock Dedicated Server and in single-player/Realms worlds. Tested on BDS 1.26.51.1.

## Commands

| Command | What it does | Who |
|---|---|---|
| `/ah` | Browse listings in a chest menu, with pages | everyone |
| `/ahsell` | List the item you're holding: set price, quantity and a description | everyone |
| `/ahmenu` | Admin panel: remove any listing, set limits, ban or unban items | players with the `op` tag |
| `/ahlist` | Browse listings in a plain menu - works without the resource pack | everyone |

Each also has a `sah:` form (`/sah:ah`, ...) in case another add-on already uses the short name.

Give someone admin access with `/tag <player> add op`.

## Money

Balances are the `money` scoreboard objective, which the pack creates on first use. Give
players money with `/scoreboard players add <player> money <amount>`, or point any other
add-on or plugin that uses a `money` scoreboard at it.

## Limits

Set from the admin panel:

| Setting | Default |
|---|---|
| Listings per player | 5 |
| Minimum price | 1 |
| Maximum price | 1,000,000 |
| Banned items | none |

Listings and settings are saved in the world itself, so they survive restarts.

## Install

The `behavior_pack` and `resource_pack` folders are the two packs. The resource pack turns the
`/ah` menu into a chest; without it, use `/ahlist`.

**On a world (single-player or Realms):** copy both folders into Minecraft's
`development_behavior_packs` and `development_resource_packs` folders, then enable both packs in
the world's settings.

**On Bedrock Dedicated Server:**

1. Copy `behavior_pack` into the server's `behavior_packs/` folder and `resource_pack` into
   `resource_packs/`.
2. Add them to your world's pack lists, in `worlds/<your world>/`:

   `world_behavior_packs.json`
   ```json
   [{ "pack_id": "f1a2b3c4-d5e6-7890-abcd-123456789abc", "version": [1, 0, 0] }]
   ```
   `world_resource_packs.json`
   ```json
   [{ "pack_id": "c4d5e6f7-a8b9-0123-dabc-456789abcdef", "version": [1, 0, 12] }]
   ```
   If the files already list other packs, add these entries to the existing lists.
3. Make sure `config/default/permissions.json` allows `@minecraft/server` and
   `@minecraft/server-ui` (it does by default).
4. Restart the server. The console should show `[SAH] Simple Auction House loaded.`

Set `texturepack-required=true` in `server.properties` if you want every player to get the chest
menu; otherwise players who decline the resource pack need `/ahlist`.

## Requirements

- A Minecraft Bedrock version with Script API `@minecraft/server` 2.8.0 and
  `@minecraft/server-ui` 2.1.0 - tested on 1.26.51. No experimental toggles needed.
