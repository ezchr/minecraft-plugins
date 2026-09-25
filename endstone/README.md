# Endstone plugins

Python plugins for [Endstone](https://github.com/EndstoneMC/endstone), which runs on top of
Bedrock Dedicated Server.

| Plugin | What it does |
|---|---|
| [chest-menu](chest-menu/) | Chest-style menus with pages, arrows and click commands, no resource pack |

## Installing any of these

1. In the plugin's folder, build a wheel: `pip wheel --no-deps -w dist .`
2. Copy the `.whl` from `dist/` into your server's `plugins/` folder.
3. Restart the server fully. `/reload` can leave plugins half-loaded.

Endstone installs the wheel into the server on startup. Plugin settings live in
`plugins/<plugin-name>/`.
