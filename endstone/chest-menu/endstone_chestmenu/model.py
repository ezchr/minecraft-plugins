"""The building blocks for menus.py."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Item:
    """One item in the chest.

    id       Bedrock item name, e.g. "minecraft:diamond". Any item or block works.
    count    Stack size shown on the icon (1-64).
    command  Optional command the clicking player runs, without the leading "/",
             e.g. "me opened the shop". It runs with that player's permissions.
    """

    id: str
    count: int = 1
    command: str | None = None


@dataclass
class Page:
    """One page of a menu: slot number -> item. Slots you leave out get the menu's filler."""

    items: dict[int, Item] = field(default_factory=dict)


@dataclass
class Menu:
    """A chest menu, opened with its own command (the key it has in MENUS).

    title        Shown at the top of the chest.
    pages        One or more Page. With more than one, arrows appear to move between them.
    filler       Item for every unused slot, or None to leave them empty.
    prev_arrow / next_arrow   Items for the page arrows (only shown when that page exists).
    prev_slot / next_slot     Where the arrows go.
    description  Shown in /help.
    default_access   Who may use the command: True = everyone, "op" = operators only.
    """

    title: str
    pages: list[Page]
    filler: str | None = "minecraft:black_stained_glass_pane"
    prev_arrow: Item = Item("minecraft:arrow")
    next_arrow: Item = Item("minecraft:arrow")
    prev_slot: int = 18
    next_slot: int = 26
    description: str = "Open the menu."
    default_access: bool | str = True
