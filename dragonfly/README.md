# Dragonfly plugins

Go packages for [Dragonfly](https://github.com/df-mc/dragonfly), the Bedrock server written in Go.
Dragonfly has no plugin loader, so each plugin here is a Go module you import into your server's
`main.go` - the plugin's README shows the exact lines to add.

| Plugin | What it does |
|---|---|
| [chest-menu](chest-menu/) | Chest-style menus from a TOML file: pages, arrows, and buttons that run commands, send messages or open other menus |
| [trader](trader/) | Villager traders with the real trading window; every offer, limit and restock comes from `traders.json` |
