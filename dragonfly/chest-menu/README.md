# chest-menu (Dragonfly)

Chest-style menus for a [Dragonfly](https://github.com/df-mc/dragonfly) server, configured
entirely from a TOML file - no menu is hardcoded. Each menu becomes a command. Buttons can run
a command, send a message, open another menu, or close the chest, and arrows turn pages.
Players can never take the items.

Built on [bedrock-gophers/inv](https://github.com/bedrock-gophers/inv), which fakes the chest
client-side. Tested against Dragonfly v0.11.5.

## Setup

Add the module to your server:

```sh
go get github.com/ezchr/minecraft-plugins/dragonfly/chest-menu
```

Then three changes in your `main.go` (a complete version is in [`example/main.go`](example/main.go)):

```go
import (
	"github.com/bedrock-gophers/intercept/intercept"
	"github.com/bedrock-gophers/inv/inv"
	chestmenu "github.com/ezchr/minecraft-plugins/dragonfly/chest-menu"
)

// 1. Before conf.New(): inv needs to see every packet, so wrap the listeners.
conf.Listeners = intercept.WrapListeners(conf.Listeners)
srv := conf.New()
intercept.Start(srv)

// 2. Load and register the menus. Load reports every mistake in the file at once.
menus, err := chestmenu.Load("menus.toml")
if err != nil {
	log.Error("menus", "err", err)
	os.Exit(1)
}
chestmenu.Register(menus, chestmenu.Options{})

// 3. In your player handler: close a player's menu when they leave.
func (h myHandler) HandleQuit(p *player.Player) {
	inv.CloseContainer(p)
}
```

Copy [`menus.example.toml`](menus.example.toml) next to your server as `menus.toml` and edit it.

## Writing menus

Every `[menus.<name>]` table is one menu, opened with `/<name>`:

```toml
[menus.shop]
title = "§l§bShop §r§8({page}/{pages})"
size = "chest"
filler = "minecraft:black_stained_glass_pane"

[[menus.shop.pages]]            # page 1

[[menus.shop.pages.items]]
slot = 13
item = "minecraft:diamond_sword"
name = "§bPvP kit"
lore = ["§7Click to claim"]
command = "kit pvp"
close = true

[[menus.shop.pages]]            # page 2

[[menus.shop.pages.items]]
slot = 13
item = "minecraft:elytra"
```

Each `[[menus.<name>.pages]]` starts a new page, and the `[[menus.<name>.pages.items]]` after
it belong to that page.

Slot numbers in a chest (a `double_chest` continues with 27-53):

```
 0  1  2  3  4  5  6  7  8
 9 10 11 12 13 14 15 16 17
18 19 20 21 22 23 24 25 26
```

### Menu settings

| Setting | What it does | Default |
|---|---|---|
| `title` | Chest title. Colour codes and placeholders work | the menu's name |
| `size` | `chest` (27), `double_chest` (54), `barrel` (27), `hopper` (5), `dropper` (9) | `chest` |
| `description` | Shown in the command list | "Opens the &lt;name&gt; menu" |
| `aliases` | Extra command names, e.g. `["store"]` | none |
| `filler` | Item for every unused slot. Leave it out for empty slots | none |
| `filler_name` | Hover text on filler items | blank |
| `[menus.<name>.previous]` / `[menus.<name>.next]` | Page arrows: `item`, `name`, `lore`, `slot` | arrows in the bottom corners |

Arrows only appear when there's a page to go to.

### Button settings

| Setting | What it does |
|---|---|
| `slot` | Where it goes (required) |
| `item` | Bedrock item or block name, e.g. `minecraft:diamond` (required) |
| `count` | Stack size, 1-64 (default 1) |
| `meta` | Item data value, for the few items that still use one |
| `name` / `lore` | Display name and lore lines |
| `command` | Command the clicking player runs. The leading `/` is optional |
| `message` | Chat message sent to the clicking player |
| `open` | Name of another menu to open |
| `close` | `true` to close the chest after the click |

A button can combine these: the chest closes first (if `close`), then the message is sent,
then the command runs, then `open` opens the next menu.

### Placeholders

`{player}` (the clicking player's name), `{page}` and `{pages}` work in titles, names, lore,
messages and commands.

## Checking your file

`chestmenu.Load` refuses a file with mistakes and lists all of them, for example:

```
menu file has 3 problem(s):
  - menu "shop" page 1 item 2: unknown item "minecraft:diamnod" (meta 0)
  - menu "shop" page 2 item 1: slot 30 is outside 0-26 for a chest
  - menu "warps" page 1 item 1: opens menu "hub", which isn't defined
```

Misspelt setting names (like `comand`) are rejected too, instead of being silently ignored.

## Permissions and reloading

`Options.Allow` decides who can open which menu, whether by its command or through another
menu's `open` button:

```go
chestmenu.Register(menus, chestmenu.Options{
	Allow: func(p *player.Player, menu string) bool {
		return menu != "admin" || isAdmin(p)
	},
})
```

`chestmenu.Reload("menus.toml")` swaps in edited menus without a restart. Adding a new menu
still needs a restart, because Dragonfly can't add commands after the server starts.
`chestmenu.Open(p, "shop")` opens a menu from your own code.

## Limitations

- **Fragile across Dragonfly updates.** inv works by calling Dragonfly's unexported session
  internals. A Dragonfly update can break it - sometimes at compile time, sometimes silently.
  Test menus after updating.
- **Clicks only.** There's no left/right/shift-click distinction; every click does the same thing.
- **Title changes reopen the chest.** When the title differs between pages (for example with
  `{page}` in it), turning a page reopens the chest, which flickers briefly. With a fixed title,
  pages swap in place.
