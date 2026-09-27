# trader (Dragonfly)

Villager traders for a [Dragonfly](https://github.com/df-mc/dragonfly) server. Each trader opens
the real Bedrock trading window, and every offer is defined in `traders.json` - any item can be
bought or sold, not just emeralds. Traders stand still, never despawn, and are saved with the
world.

## Requirements

The trading window needs changes that are not in upstream Dragonfly, so this plugin uses the
[ezchr/dragonfly](https://github.com/ezchr/dragonfly) fork (branch `server-current`). Go only
honours `replace` lines in your own server's `go.mod`, so add the same one there:

```
replace github.com/df-mc/dragonfly => github.com/ezchr/dragonfly v0.11.6-0.20260927035501-c3f3ccab3e0e
```

## Setup

Add the module to your server:

```sh
go get github.com/ezchr/minecraft-plugins/dragonfly/trader
```

Then three changes in your `main.go` (a complete version is in [`example/main.go`](example/main.go)):

```go
import "github.com/ezchr/minecraft-plugins/dragonfly/trader"

// 1. Before conf.New(): register the trader entity so placed traders are saved with the world.
conf.Entities = entity.DefaultRegistry.Config().New(append(entity.DefaultRegistry.Types(), trader.Type))

// 2. After conf.New(): load traders.json and add /trader. Pass your own admin check.
trader.Load(slog.Default())
cmd.Register(trader.Command(isAdmin))

// 3. In your player handler: open the trading window on right-click.
func (h handler) HandleItemUseOnEntity(ctx *player.Context, e world.Entity) {
	if trader.Interact(ctx.Player(), e) {
		ctx.Cancel()
	}
}
```

## Commands

Everything is under `/trader`, for whoever your admin check allows:

| Command | What it does |
|---|---|
| `/trader create <id>` | Places trader `<id>` where you stand, facing you |
| `/trader remove <trader>` | Removes a placed trader from any distance - suggestions list every placed trader |
| `/trader remove` | Removes the nearest trader within 6 blocks |
| `/trader list` | Every trader type in `traders.json`, with where each one is placed |
| `/trader reload` | Re-reads `traders.json` - no restart needed |

Placed traders are named after their id. When several share an id they are numbered:
`blacksmith_1`, `blacksmith_2`.

## traders.json

Written with an example trader the first time the server starts (see
[`traders.example.json`](traders.example.json)). Each key is a trader id:

```json
{
  "traders": {
    "blacksmith": {
      "name": "§6Blacksmith",
      "limitPer": "player",
      "restockMinutes": 60,
      "offers": [
        {
          "buy":  { "item": "minecraft:iron_ingot", "count": 10 },
          "buy2": { "item": "minecraft:coal", "count": 4 },
          "sell": { "item": "minecraft:iron_sword", "count": 1,
                    "name": "§bSharp Sword", "lore": ["line"],
                    "enchantments": { "sharpness": 2 } },
          "maxUses": 5
        }
      ]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Name tag over the trader and the trading window title |
| `limitPer` | `"player"` (default): each player gets their own `maxUses`. `"global"`: shared by everyone |
| `restockMinutes` | Resets every offer's use count this often. `0` or left out: never restocks |
| `offers[].buy` / `buy2` | What the player pays. `buy2` is optional |
| `offers[].sell` | What the player gets |
| `offers[].maxUses` | Uses before the offer locks. `0` or left out: unlimited |

Every item takes `item` and `count`, and optionally `meta`, `name`, `lore` and `enchantments`
(any enchantment at any level). Bad offers are skipped and reported when the file loads - one
mistake never stops the rest from working.

Editing `traders.json` and running `/trader reload` updates every placed trader: a trader only
remembers its id, and looks its offers up each time the window opens.

## Files

Next to your server, the plugin writes:

- `traders.json` - the trader definitions (you edit this)
- `trader_uses.json` - how many times each offer has been used, for `maxUses` and restocks
- `trader_placed.json` - where each trader is placed, so `/trader remove` and `/trader list` can
  find traders in chunks that are not loaded
