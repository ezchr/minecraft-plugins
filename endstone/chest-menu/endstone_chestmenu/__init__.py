"""chestmenu - chest-style menus for Endstone, with no resource pack.

Menus are defined in menus.py. The chest is faked client-side (see protocol.py) and put
back the moment the player closes it, so the world is never changed.

Clicks are deliberately left for BDS to answer: it has no such container, so it rejects every
click and the client snaps the item straight back. The plugin only watches which slot was
clicked, to turn pages or run an item's command.
"""

import json
import math
from dataclasses import dataclass
from pathlib import Path

from endstone import Player
from endstone.command import Command, CommandSender
from endstone.event import PacketReceiveEvent, PacketSendEvent, event_handler
from endstone.plugin import Plugin

from . import protocol as proto
from .menus import MENUS
from .model import Item, Menu

# Set to True once after a Minecraft/BDS update, restart, and join the server: the plugin saves
# the new item IDs to plugins/chestmenu/item_ids.json. Set it back to False afterwards - while
# it is on, every outgoing packet passes through the plugin.
REFRESH_ITEM_IDS = False


@dataclass
class _OpenMenu:
    menu_name: str
    x: int
    y: int
    z: int
    orig_block: int
    orig_above: int
    window: int
    page: int = 0


def _build_commands() -> dict:
    return {
        name: {"description": menu.description, "usages": [f"/{name}"],
               "permissions": [f"chestmenu.command.{name}"]}
        for name, menu in MENUS.items()
    }


def _build_permissions() -> dict:
    return {
        f"chestmenu.command.{name}": {"description": f"Allow using /{name}.", "default": menu.default_access}
        for name, menu in MENUS.items()
    }


class ChestMenuPlugin(Plugin):
    api_version = "0.11"
    commands = _build_commands()
    permissions = _build_permissions()

    def on_enable(self) -> None:
        self.register_events(self)
        if REFRESH_ITEM_IDS:
            self.register_events(_ItemIdRefresher(self))
            self.logger.warning("REFRESH_ITEM_IDS is on - join the server once, then turn it off")

        self._item_ids = self._load_item_ids()
        self._block_ids: dict[str, int] = {}
        self._open: dict[str, _OpenMenu] = {}
        self._next_window = 1
        try:
            self._chest = self.server.create_block_data("minecraft:chest").runtime_id
            self._air = self.server.create_block_data("minecraft:air").runtime_id
        except Exception as error:
            self._chest = self._air = None
            self.logger.error(f"could not resolve the chest block: {error} - menus disabled")
        self._validate_menus()

    # --- setup -----------------------------------------------------------------------------

    def _load_item_ids(self) -> dict[str, int]:
        # A refreshed table in the plugin's data folder wins over the one shipped with it.
        for path in (Path(self.data_folder) / "item_ids.json", Path(__file__).with_name("item_ids.json")):
            try:
                ids = json.loads(path.read_text(encoding="utf-8"))
                self.logger.info(f"loaded {len(ids)} item IDs from {path}")
                return ids
            except FileNotFoundError:
                continue
            except Exception as error:
                self.logger.error(f"could not read {path}: {error}")
        self.logger.error("no item_ids.json found - every item will show as empty")
        return {}

    def _validate_menus(self) -> None:
        for name, menu in MENUS.items():
            where = f"menu '{name}'"
            if not menu.pages:
                self.logger.error(f"{where} has no pages")
            for slot in (menu.prev_slot, menu.next_slot):
                if not 0 <= slot < proto.CHEST_SLOTS:
                    self.logger.error(f"{where}: arrow slot {slot} is outside 0-{proto.CHEST_SLOTS - 1}")
            names = [menu.prev_arrow.id, menu.next_arrow.id] + ([menu.filler] if menu.filler else [])
            for number, page in enumerate(menu.pages, 1):
                for slot, item in page.items.items():
                    if not 0 <= slot < proto.CHEST_SLOTS:
                        self.logger.error(f"{where} page {number}: slot {slot} is outside 0-{proto.CHEST_SLOTS - 1}")
                    if len(menu.pages) > 1 and slot in (menu.prev_slot, menu.next_slot):
                        self.logger.warning(f"{where} page {number}: slot {slot} is also an arrow slot")
                    names.append(item.id)
            for item_id in sorted(set(names)):
                if item_id not in self._item_ids:
                    self.logger.error(f"{where}: unknown item '{item_id}' (check item_ids.json)")

    def _block_id(self, item_id: str) -> int:
        # Block items also need their block's runtime ID to render; plain items use 0.
        if item_id not in self._block_ids:
            try:
                self._block_ids[item_id] = self.server.create_block_data(item_id).runtime_id
            except Exception:
                self._block_ids[item_id] = 0
        return self._block_ids[item_id]

    def _encode(self, entry: Item | str | None) -> bytes:
        if entry is None:
            return proto.item_air()
        item_id, count = (entry, 1) if isinstance(entry, str) else (entry.id, entry.count)
        net_id = self._item_ids.get(item_id)
        if net_id is None:
            return proto.item_air()
        return proto.item(net_id, max(1, min(64, count)), self._block_id(item_id))

    # --- opening ---------------------------------------------------------------------------

    def on_command(self, sender: CommandSender, command: Command, args: list[str]) -> bool:
        if not isinstance(sender, Player):
            sender.send_error_message("Only a player can open a menu.")
            return True
        if self._chest is None or command.name not in MENUS:
            sender.send_error_message("That menu is unavailable.")
            return True
        self._open_menu(sender, command.name)
        return True

    def _alloc_window(self) -> int:
        # A fresh window ID per open: the client ignores ContainerOpen for one still in use.
        self._next_window = self._next_window % 99 + 1
        return self._next_window

    def _open_menu(self, player: Player, name: str) -> None:
        # Fake the chest 2 blocks behind the player at foot level, so the client's collision with
        # the fake block can't push them, and it's out of sight before the window covers it.
        loc = player.location
        yaw = math.radians(loc.yaw)
        x = int(math.floor(loc.x + 2.0 * math.sin(yaw)))
        y = int(math.floor(loc.y))
        z = int(math.floor(loc.z - 2.0 * math.cos(yaw)))
        orig_block = orig_above = self._air
        try:
            orig_block = player.dimension.get_block_at(x, y, z).data.runtime_id
            orig_above = player.dimension.get_block_at(x, y + 1, z).data.runtime_id
        except Exception:
            pass

        state = _OpenMenu(name, x, y, z, orig_block, orig_above, self._alloc_window())
        self._open[player.xuid] = state
        player.send_packet(proto.PID_UPDATE_BLOCK, proto.update_block(x, y, z, self._chest))
        player.send_packet(proto.PID_UPDATE_BLOCK, proto.update_block(x, y + 1, z, self._air))
        player.send_packet(proto.PID_BLOCK_ACTOR_DATA, proto.block_actor_data(x, y, z, MENUS[name].title))

        xuid = player.xuid

        def show() -> None:
            live = self._player(xuid)
            if live is not None and self._open.get(xuid) is state:
                live.send_packet(proto.PID_CONTAINER_OPEN, proto.container_open(state.window, x, y, z))
                self._send_page(live, state)

        # ~500ms, so the client has built the chest's block entity before ContainerOpen.
        self.server.scheduler.run_task(self, show, delay=10)

    def _layout(self, menu: Menu, page: int) -> list[bytes]:
        slots: list[Item | str | None] = [menu.filler] * proto.CHEST_SLOTS
        for slot, item in menu.pages[page].items.items():
            if 0 <= slot < proto.CHEST_SLOTS:
                slots[slot] = item
        if page > 0:
            slots[menu.prev_slot] = menu.prev_arrow
        if page < len(menu.pages) - 1:
            slots[menu.next_slot] = menu.next_arrow
        return [self._encode(entry) for entry in slots]

    def _send_page(self, player: Player, state: _OpenMenu) -> None:
        menu = MENUS[state.menu_name]
        player.send_packet(proto.PID_INVENTORY_CONTENT,
                           proto.inventory_content(state.window, self._layout(menu, state.page)))

    # --- clicks and closing ----------------------------------------------------------------

    @event_handler
    def on_packet_receive(self, event: PacketReceiveEvent) -> None:
        pid = int(event.packet_id)
        if pid == proto.PID_ITEM_STACK_REQUEST:
            self._on_click(event)
        elif pid == proto.PID_CONTAINER_CLOSE:
            self._on_close(bytes(event.payload))

    def _on_click(self, event: PacketReceiveEvent) -> None:
        player = event.player
        state = self._open.get(player.xuid) if player is not None else None
        if state is None:
            return  # not one of our menus - BDS handles it
        menu = MENUS[state.menu_name]
        for container, slot, is_source in proto.parse_item_stack_request(bytes(event.payload)):
            if not is_source or container != proto.CONTAINER_LEVEL_ENTITY:
                continue
            xuid = player.xuid
            if slot == menu.prev_slot and state.page > 0:
                self._later(xuid, lambda p: self._turn(p, -1))
            elif slot == menu.next_slot and state.page < len(menu.pages) - 1:
                self._later(xuid, lambda p: self._turn(p, 1))
            else:
                item = menu.pages[state.page].items.get(slot)
                if item is not None and item.command:
                    command = item.command
                    self._later(xuid, lambda p: p.perform_command(command))
            return

    def _later(self, xuid: str, action) -> None:
        # A couple of ticks later, so it lands after BDS's snap-back of the clicked item.
        def run() -> None:
            live = self._player(xuid)
            if live is not None and xuid in self._open:
                action(live)

        self.server.scheduler.run_task(self, run, delay=2)

    def _turn(self, player: Player, step: int) -> None:
        state = self._open.get(player.xuid)
        if state is None:
            return
        pages = len(MENUS[state.menu_name].pages)
        state.page = max(0, min(pages - 1, state.page + step))
        self._send_page(player, state)

    def _on_close(self, payload: bytes) -> None:
        if not payload:
            return
        for xuid, state in list(self._open.items()):
            if state.window != payload[0]:
                continue
            player = self._player(xuid)
            if player is not None:
                player.send_packet(proto.PID_UPDATE_BLOCK,
                                   proto.update_block(state.x, state.y, state.z, state.orig_block))
                player.send_packet(proto.PID_UPDATE_BLOCK,
                                   proto.update_block(state.x, state.y + 1, state.z, state.orig_above))
            del self._open[xuid]

    def _player(self, xuid: str):
        for player in self.server.online_players:
            if player.xuid == xuid:
                return player
        return None


class _ItemIdRefresher:
    """Saves the server's item registry once. Only registered when REFRESH_ITEM_IDS is on."""

    def __init__(self, plugin: ChestMenuPlugin) -> None:
        self._plugin = plugin
        self._done = False

    @event_handler
    def on_packet_send(self, event: PacketSendEvent) -> None:
        if self._done or int(event.packet_id) != proto.PID_ITEM_REGISTRY:
            return
        self._done = True
        try:
            ids = proto.parse_item_registry(bytes(event.payload))
            path = Path(self._plugin.data_folder) / "item_ids.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(dict(sorted(ids.items())), indent=0), encoding="utf-8")
            self._plugin.logger.info(f"saved {len(ids)} item IDs to {path} - turn REFRESH_ITEM_IDS off and restart")
        except Exception as error:
            self._plugin.logger.error(f"could not read the item registry: {error}")
