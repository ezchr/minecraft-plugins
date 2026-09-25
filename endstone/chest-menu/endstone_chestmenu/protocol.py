"""Bedrock packet encoding for the fake chest. You shouldn't need to edit this file.

Bedrock has no server API to force-open a container, so the plugin fakes one the way the
bedrock-gophers/inv library does: UpdateBlock a chest (and air above it) client-side,
BlockActorData to give it a chest block-entity, then ContainerOpen + InventoryContent.

Every layout here was checked against packets captured from BDS 1.26.51.1 (protocol 2193).
Packet IDs and item encodings are version-specific: a Minecraft update can change them.
"""

import struct

PID_UPDATE_BLOCK = 21
PID_CONTAINER_OPEN = 46
PID_CONTAINER_CLOSE = 47
PID_INVENTORY_CONTENT = 49
PID_BLOCK_ACTOR_DATA = 56
PID_ITEM_STACK_REQUEST = 147
PID_ITEM_REGISTRY = 162

CONTAINER_TYPE_CHEST = 0
# FullContainerName container ID the client uses for a block container like our chest.
CONTAINER_LEVEL_ENTITY = 7
BLOCK_UPDATE_NETWORK = 0b0010
CHEST_SLOTS = 27

_NBT_END = 0
_NBT_STRING = 8
_NBT_COMPOUND = 10


# --- primitives ----------------------------------------------------------------------------

def uvarint(value: int) -> bytes:
    out = bytearray()
    value &= (1 << 64) - 1
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def svarint(value: int, bits: int = 32) -> bytes:
    zig = (value << 1) ^ (value >> (bits - 1))
    return uvarint(zig & ((1 << bits) - 1))


def _u16le(n: int) -> bytes:
    return struct.pack("<H", n & 0xFFFF)


def _i16le(n: int) -> bytes:
    return struct.pack("<h", n)


def _u32le(n: int) -> bytes:
    return struct.pack("<I", n & 0xFFFFFFFF)


def _block_pos(x: int, y: int, z: int) -> bytes:
    return svarint(x) + svarint(y) + svarint(z)


# --- packets -------------------------------------------------------------------------------

def update_block(x: int, y: int, z: int, runtime_id: int) -> bytes:
    return _block_pos(x, y, z) + uvarint(runtime_id) + uvarint(BLOCK_UPDATE_NETWORK) + uvarint(0)


def container_open(window_id: int, x: int, y: int, z: int) -> bytes:
    return bytes([window_id & 0xFF, CONTAINER_TYPE_CHEST]) + _block_pos(x, y, z) + svarint(-1, 64)


def _nbt_string(text: str) -> bytes:
    # Network little-endian NBT string: unsigned varint length + UTF-8 bytes.
    raw = text.encode("utf-8")
    return uvarint(len(raw)) + raw


def block_actor_data(x: int, y: int, z: int, title: str) -> bytes:
    # {"id": "Chest", "CustomName": title} - the CustomName is the menu's window title.
    def string_tag(key: str, value: str) -> bytes:
        return bytes([_NBT_STRING]) + _nbt_string(key) + _nbt_string(value)

    nbt = (
        bytes([_NBT_COMPOUND]) + _nbt_string("")
        + string_tag("id", "Chest")
        + string_tag("CustomName", title)
        + bytes([_NBT_END])
    )
    return _block_pos(x, y, z) + nbt


def item_air() -> bytes:
    # 8 bytes, exactly what the server sends for an empty slot.
    return _i16le(0) + _u16le(0) + uvarint(0) + b"\x00" + uvarint(0) + uvarint(0)


def item(net_id: int, count: int, block_runtime_id: int = 0) -> bytes:
    if net_id == 0:
        return item_air()
    # extra data: int16 nbt-length(0) + uint32 canPlaceOn count(0) + uint32 canBreak count(0).
    extra = _i16le(0) + _u32le(0) + _u32le(0)
    return (
        _i16le(net_id) + _u16le(count) + uvarint(0) + b"\x00"
        + uvarint(block_runtime_id) + uvarint(len(extra)) + extra
    )


def inventory_content(window_id: int, items: list[bytes]) -> bytes:
    body = uvarint(window_id) + uvarint(len(items)) + b"".join(items)
    body += bytes([0]) + b"\x00"  # FullContainerName: containerID 0, no dynamic container
    body += item_air()  # StorageItem
    return body


# --- reading client clicks -----------------------------------------------------------------

def parse_item_stack_request(b: bytes) -> list[tuple[int, int, bool]]:
    """(containerID, slot, is_source) for every slot a click touched.

    Layout read from captured clicks on BDS 1.26.51.1: request count, then per request a
    zigzag-varint request ID and an action count; a take/place action is its type byte, two
    more bytes, then source and destination slot infos (container ID, dynamic-container flag,
    slot, int32 stack ID). Only take/place (types 0 and 1) are decoded; anything else stops.
    """
    touches: list[tuple[int, int, bool]] = []
    o = 0

    def uv() -> int:
        nonlocal o
        shift = value = 0
        while True:
            byte = b[o]
            o += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
            shift += 7

    try:
        for _ in range(uv()):  # requests
            uv()  # request ID
            for _ in range(uv()):  # actions
                kind = b[o]
                o += 1
                if kind not in (0, 1):
                    raise ValueError(f"unhandled action type {kind}")
                o += 2
                for side in range(2):  # 0 = source, 1 = destination
                    container, dynamic = b[o], b[o + 1]
                    o += 2
                    if dynamic:
                        o += 4
                    slot = b[o]
                    o += 5  # slot + int32 stack ID
                    touches.append((container, slot, side == 0))
            for _ in range(uv()):  # filter strings
                o += uv()
            o += 4  # filter cause
    except Exception:
        pass
    return touches


# --- reading the item registry (only used by the optional ID-refresh mode) ----------------

def parse_item_registry(b: bytes) -> dict[str, int]:
    """Item name -> network ID from an ItemRegistry packet payload."""
    o = 0

    def uv() -> int:
        nonlocal o
        shift = value = 0
        while True:
            byte = b[o]
            o += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
            shift += 7

    def zz() -> int:
        v = uv()
        return (v >> 1) ^ -(v & 1)

    def string() -> str:
        nonlocal o
        n = uv()
        s = b[o:o + n]
        o += n
        return s.decode("utf-8", "replace")

    def skip_payload(tag: int) -> None:
        # Network little-endian NBT, just enough to step over each entry's component data.
        nonlocal o
        if tag == 1:
            o += 1
        elif tag == 2:
            o += 2
        elif tag in (3, 4):
            zz()
        elif tag == 5:
            o += 4
        elif tag == 6:
            o += 8
        elif tag == 7:
            o += zz()
        elif tag == 8:
            string()
        elif tag == 9:
            inner = b[o]
            o += 1
            for _ in range(zz()):
                skip_payload(inner)
        elif tag == 10:
            while True:
                inner = b[o]
                o += 1
                if inner == 0:
                    return
                string()
                skip_payload(inner)
        elif tag in (11, 12):
            for _ in range(zz()):
                zz()
        else:
            raise ValueError(f"unknown NBT tag {tag}")

    ids: dict[str, int] = {}
    for _ in range(uv()):
        name = string()
        net_id = struct.unpack_from("<h", b, o)[0]
        o += 2
        o += 1  # component-based flag
        zz()  # version
        tag = b[o]
        o += 1
        if tag:
            string()  # root name
            skip_payload(tag)
        ids[name] = net_id
    return ids
