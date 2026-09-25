# Minecraft plugins

Plugins for three Minecraft server platforms, one folder each:

| Folder | Platform | Language |
|---|---|---|
| [`endstone/`](endstone/) | [Endstone](https://github.com/EndstoneMC/endstone) on Bedrock Dedicated Server | Python |
| [`paper/`](paper/) | [Paper](https://papermc.io/) (Java Edition) | Java |
| [`dragonfly/`](dragonfly/) | [Dragonfly](https://github.com/df-mc/dragonfly) (Bedrock, written in Go) | Go |
| [`addons/`](addons/) | Bedrock add-ons: worlds, Realms and any Bedrock server | JavaScript + JSON |

Each plugin has its own folder with a README covering install and configuration.

## Plugins

### Endstone

- [**chest-menu**](endstone/chest-menu/) - chest-style menus with pages, arrows and click
  commands, no resource pack needed.

### Dragonfly

- [**chest-menu**](dragonfly/chest-menu/) - chest-style menus configured from a TOML file:
  pages, arrows, and buttons that run commands, send messages or open other menus.

### Add-ons

- [**simple-auction-house**](addons/simple-auction-house/) - player-to-player auction house with
  a chest menu: `/ah`, `/ahsell`, `/ahmenu`.

## License

MIT - see [LICENSE](LICENSE).
