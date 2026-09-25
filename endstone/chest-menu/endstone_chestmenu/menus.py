"""Your menus - this is the only file you need to edit.

Each entry in MENUS becomes a command: the key is the command name, so "chestmenu" gives
/chestmenu. Pick names no other plugin or add-on already uses.

Slot numbers in a single chest:

     0  1  2  3  4  5  6  7  8
     9 10 11 12 13 14 15 16 17
    18 19 20 21 22 23 24 25 26

Items are named like "minecraft:diamond" (see item_ids.json for every name). Give an item a
`command` to make clicking it run that command as the player. Clicked items always snap back
into place - players can never take anything out.

After editing, rebuild the wheel and restart the server (a full restart, not /reload).
"""

from .model import Item, Menu, Page

MENUS = {
    "chestmenu": Menu(
        title="Server Menu",
        pages=[
            Page({
                10: Item("minecraft:diamond_sword", command="me wants to fight"),
                12: Item("minecraft:compass", command="me is looking around"),
                14: Item("minecraft:emerald", count=16),
                16: Item("minecraft:book"),
            }),
            Page({
                11: Item("minecraft:diamond", count=64),
                13: Item("minecraft:netherite_ingot"),
                15: Item("minecraft:golden_apple", count=8),
            }),
            Page({
                12: Item("minecraft:elytra"),
                14: Item("minecraft:totem_of_undying"),
            }),
        ],
    ),
}
