# chestmenu (Endstone)

Chest-style menus for a Bedrock Dedicated Server running [Endstone](https://github.com/EndstoneMC/endstone),
with **no resource pack**. A command opens a chest full of item "buttons": arrows flip
between pages, and clicking an item can run a command. Players can never take items out -
every click snaps straight back.

> **Built for BDS 1.26.51.1 (protocol 2193).** It talks to the client with raw packets, and
> those change between Minecraft versions. See [After a Minecraft update](#after-a-minecraft-update).

## Install

1. Build the wheel (needs Python 3.10+):
   ```sh
   pip wheel --no-deps -w dist .
   ```
2. Copy `dist/endstone_chestmenu-*.whl` into your server's `plugins/` folder.
3. Restart the server fully (not `/reload`).

Then use `/chestmenu` in game.

## Make your own menus

Everything is in [`endstone_chestmenu/menus.py`](endstone_chestmenu/menus.py). Each entry in
`MENUS` is one menu, and its key is the command that opens it:

```python
MENUS = {
    "shop": Menu(
        title="Shop",
        pages=[
            Page({
                11: Item("minecraft:diamond_sword", command="me wants to fight"),
                13: Item("minecraft:emerald", count=16),
                15: Item("minecraft:compass", command="me is looking around"),
            }),
            Page({
                13: Item("minecraft:elytra"),
            }),
        ],
    ),
    "warps": Menu(title="Warps", pages=[Page({13: Item("minecraft:ender_pearl", command="spawn")})]),
}
```

That gives you `/shop` and `/warps`.

Slot numbers:

```
 0  1  2  3  4  5  6  7  8
 9 10 11 12 13 14 15 16 17
18 19 20 21 22 23 24 25 26
```

| Setting | What it does | Default |
|---|---|---|
| `title` | Text at the top of the chest | required |
| `pages` | List of `Page({slot: Item(...)})` | required |
| `filler` | Item for every unused slot, or `None` for empty | black stained glass pane |
| `prev_arrow` / `next_arrow` | Items for the page arrows | arrow |
| `prev_slot` / `next_slot` | Where the arrows sit | 18 / 26 |
| `description` | Shown in `/help` | "Open the menu." |
| `default_access` | `True` = everyone, `"op"` = operators only | `True` |

`Item(id, count=1, command=None)`:

- **`id`** is any Bedrock item or block name, like `"minecraft:diamond"`. Every valid name
  is listed in [`item_ids.json`](endstone_chestmenu/item_ids.json).
- **`command`** runs as the player who clicked, without the leading `/`, using that player's
  own permissions.

Arrows only appear when there's a page to go to. On startup the plugin checks your menus and
logs any unknown item name or out-of-range slot, so check the console after editing.

Pick command names nothing else on your server uses - a clash (for example with an add-on
that already has `/menu`) stops the plugin's command from registering.

## After a Minecraft update

Items are sent to the client by numeric ID, and those IDs change between versions. After
updating BDS:

1. In `endstone_chestmenu/__init__.py`, set `REFRESH_ITEM_IDS = True`, rebuild and restart.
2. Join the server once. The plugin saves the new table to `plugins/chestmenu/item_ids.json`
   (that copy overrides the one shipped with the plugin).
3. Set `REFRESH_ITEM_IDS = False` again, rebuild and restart. While it's on, every packet the
   server sends passes through the plugin.

If menus break in other ways after an update (items missing, the chest not opening), the
packet layouts in `protocol.py` have likely changed too.

## How it works

Bedrock has no server API to open a container that doesn't exist, so the plugin fakes one,
the way the [bedrock-gophers/inv](https://github.com/bedrock-gophers/inv) library does:

1. It tells the player's client there's a chest 2 blocks behind them (UpdateBlock), gives
   it a chest block-entity with your title (BlockActorData), then opens it (ContainerOpen)
   and fills it (InventoryContent). The world itself is never changed.
2. Clicks go to the server as normal. The server has no such chest, so it rejects them and
   the client puts the item back. The plugin reads which slot was clicked to flip pages or
   run the item's command.
3. When the player closes the chest, the fake block is replaced with what's really there.

Performance: the only thing hooked is incoming packets, and anything that isn't a click in an
open menu or a menu close is skipped immediately.
