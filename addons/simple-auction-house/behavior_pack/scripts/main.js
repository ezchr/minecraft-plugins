/**
 * ═══════════════════════════════════════════════════════════════════
 *  SIMPLE AUCTION HOUSE  —  main.js
 * ═══════════════════════════════════════════════════════════════════
 *  Commands:
 *    /ah      – Browse listings (chest UI, paginated)
 *    /ahsell  – Sell held item (price / qty / description)
 *    /ahmenu  – Admin panel  [requires "op" tag]
 *
 *  Currency: scoreboard objective named "money"
 *  Storage:  world dynamic properties (max ~32 KB per key)
 * ═══════════════════════════════════════════════════════════════════
 */

import {
	system,
	world,
	ItemStack,
	EquipmentSlot,
	EnchantmentTypes,
	CommandPermissionLevel,
	CustomCommandStatus,
	Player
} from '@minecraft/server';
import { ActionFormData, ModalFormData } from '@minecraft/server-ui';
import { ChestFormData } from './extensions/forms.js';
import { readChunked, writeChunked } from './extensions/chunkstore.js';

// ───────────────────────────────────────────────────────────────────
// CONSTANTS
// ───────────────────────────────────────────────────────────────────
const MONEY_OBJ      = 'money';
const LISTINGS_KEY   = 'sah:listings';
const SETTINGS_KEY   = 'sah:settings';

const ITEMS_PER_PAGE = 45;   // rows 0-4 of the 54-slot chest (5×9)
const PREV_SLOT      = 45;   // bottom-left      ◀
const LIST_SLOT      = 48;   // list-item shortcut (sign)
const BACK_SLOT      = 49;   // bottom-centre     back to Main Menu
const SORT_SLOT      = 50;   // cycle sort mode (hopper)
const NEXT_SLOT      = 53;   // bottom-right      ▶

const SORT_MODES = ['A-Z', 'Price: Low-High', 'Price: High-Low'];

/**
 * Sort choice per player, kept in memory rather than threaded through every
 * openAH() call. openAH() is called from ~15 places (purchase confirm, reclaim,
 * admin remove, ...), and none of them know or care about sort - only the nav
 * row does. A module-level map means every existing call site keeps working
 * unchanged and still lands back on whatever sort the player had picked.
 */
const sortModeFor = new Map();

function getSortMode(player) {
	return sortModeFor.get(player.id) ?? SORT_MODES[0];
}

function cycleSortMode(player) {
	const current = SORT_MODES.indexOf(getSortMode(player));
	const next = SORT_MODES[(current + 1) % SORT_MODES.length];
	sortModeFor.set(player.id, next);
	return next;
}

function sortListings(listings, mode) {
	const sorted = [...listings];
	if (mode === 'Price: Low-High') sorted.sort((a, b) => a.price - b.price);
	else if (mode === 'Price: High-Low') sorted.sort((a, b) => b.price - a.price);
	else sorted.sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)));
	return sorted;
}

/** Glass-pane typeIds used as filler / nav backgrounds */
const FILLER_GREY  = 'minecraft:gray_stained_glass_pane';
const FILLER_BLACK = 'minecraft:black_stained_glass_pane';

const DEFAULT_SETTINGS = {
	maxPerPlayer : 5,
	maxPrice     : 1_000_000,
	minPrice     : 1,
};

// ───────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ───────────────────────────────────────────────────────────────────

const BANNED_KEY = 'sah:banned_items';

/** @returns {string[]} typeIds that may not be listed */
function getBannedItems() {
	try {
		const raw = world.getDynamicProperty(BANNED_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

/** @param {string[]} arr */
function saveBannedItems(arr) {
	try {
		world.setDynamicProperty(BANNED_KEY, JSON.stringify(arr));
	} catch (e) {
		console.error('[SAH] Failed to save banned items:', e);
	}
}

/** @returns {Array} Array of all active listing objects */
function getListings() {
	const data = readChunked(LISTINGS_KEY, []);
	return Array.isArray(data) ? data : [];
}

/**
 * @param {Array} arr - Array of listing objects to persist
 * @returns {boolean} false if the write failed, in which case the caller must
 *   not go on to take an item from the seller.
 */
function saveListings(arr) {
	const ok = writeChunked(LISTINGS_KEY, arr);
	if (!ok) {
		console.error('[SAH] Failed to save listings (' + arr.length + ' entries).');
	}
	return ok;
}

/** @returns {{ maxPerPlayer, maxPrice, minPrice }} */
function getSettings() {
	try {
		const raw = world.getDynamicProperty(SETTINGS_KEY);
		return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** @param {object} s - Settings object */
function saveSettings(s) {
	world.setDynamicProperty(SETTINGS_KEY, JSON.stringify(s));
}

// ───────────────────────────────────────────────────────────────────
// MONEY HELPERS
// ───────────────────────────────────────────────────────────────────

function ensureMoneyObjective() {
	let obj = world.scoreboard.getObjective(MONEY_OBJ);
	if (!obj) obj = world.scoreboard.addObjective(MONEY_OBJ, 'Money');
	return obj;
}

/** @param {Player} player @returns {number} */
function getMoney(player) {
	const obj = world.scoreboard.getObjective(MONEY_OBJ);
	if (!obj) return 0;
	try { return obj.getScore(player.scoreboardIdentity) ?? 0; }
	catch { return 0; }
}

/** @param {Player} player @param {number} delta - positive to add, negative to deduct */
function changeMoney(player, delta) {
	const obj = ensureMoneyObjective();
	obj.setScore(player.scoreboardIdentity, getMoney(player) + delta);
}

// ───────────────────────────────────────────────────────────────────
// ITEM SERIALIZATION
// ───────────────────────────────────────────────────────────────────

/**
 * Converts an ItemStack to a plain object safe to store as JSON.
 * @param {ItemStack} item
 * @returns {object}
 */
function serializeItem(item) {
	const enchComp  = item.getComponent('enchantable');
	const enchants  = [];
	if (enchComp) {
		try {
			for (const e of enchComp.getEnchantments()) {
				enchants.push({ id: e.type.id, level: e.level });
			}
		} catch {}
	}
	const durComp = item.getComponent('durability');
	return {
		typeId   : item.typeId,
		amount   : item.amount,
		nameTag  : item.nameTag   ?? null,
		lore     : item.getLore() ?? [],
		enchants,
		damage   : durComp ? durComp.damage : 0,
		// Stored alongside the damage so the listing grid can draw a wear bar.
		// Damage on its own is meaningless - 100 is nearly dead on a gold pick
		// and barely used on a netherite one.
		maxDurability: durComp ? durComp.maxDurability : 0,
	};
}

/**
 * Reconstructs an ItemStack from a serialised object.
 * @param {object} data - Previously returned by serializeItem()
 * @returns {ItemStack}
 */
function deserializeItem(data) {
	try {
		const item = new ItemStack(data.typeId, Math.max(1, data.amount ?? 1));
		if (data.nameTag) item.nameTag = data.nameTag;
		if (data.lore?.length) item.setLore(data.lore);

		if (data.enchants?.length) {
			const enchComp = item.getComponent('enchantable');
			if (enchComp) {
				for (const e of data.enchants) {
					try {
						const enchType = EnchantmentTypes.get(e.id);
						if (enchType) enchComp.addEnchantment({ type: enchType, level: e.level });
					} catch {}
				}
			}
		}

		const durComp = item.getComponent('durability');
		if (durComp && data.damage) durComp.damage = data.damage;

		return item;
	} catch (e) {
		console.error('[SAH] deserializeItem error for ' + data?.typeId + ':', e);
		// Fall back to a basic stack
		return new ItemStack(data.typeId, Math.max(1, data.amount ?? 1));
	}
}

// ───────────────────────────────────────────────────────────────────
// MISC HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * Human-readable item name from a listing object.
 *
 * Always derived from the typeId, never from nameTag: an anvil rename is the
 * seller's own text, so a "Diamond Sword" renamed to "Dirt" would be listed as
 * dirt. Buyers need to see what the item actually is.
 *
 * Any namespace is dropped, not just minecraft: - an add-on item would otherwise
 * read "oresplus:ruby sword" instead of "Ruby Sword".
 */
/** "oresplus:ruby_sword" -> "Ruby Sword". Any namespace, not just minecraft:. */
function realItemName(typeId) {
	return String(typeId ?? '')
		.replace(/^[a-z0-9_.-]+:/i, '')
		.replace(/_/g, ' ')
		.replace(/(^\w|\s\w)/g, m => m.toUpperCase());
}

function getDisplayName(listing) {
	return realItemName(listing.item.typeId);
}

/** Roman numerals for enchantment levels, which never exceed a handful. */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Enchantment lines for a listing's hover text, e.g. "§7Sharpness V".
 * Level I is written without a numeral, matching how the game labels them.
 */
function enchantLines(listing) {
	const list = listing.item?.enchants;
	if (!Array.isArray(list) || list.length === 0) return [];

	return list.map(e => {
		const name = String(e.id ?? '')
			.replace(/^[a-z0-9_.]+:/i, '')
			.replace(/_/g, ' ')
			.replace(/(^\w|\s\w)/g, m => m.toUpperCase());
		const lvl = Number(e.level) || 1;
		const numeral = lvl > 1 ? ' ' + (ROMAN[lvl] ?? lvl) : '';
		return `§b${name}${numeral}`;
	});
}

/** Whether a listing should render with the enchantment glint. */
function isEnchanted(listing) {
	return (listing.item?.enchants?.length ?? 0) > 0;
}

/**
 * Remaining durability as the 1-99 value the chest UI's wear bar expects, or 0
 * for an item that has no durability at all (the bar hides on 0).
 *
 * Older listings were stored before maxDurability was recorded, so they have no
 * denominator and are treated as undamaged rather than guessed at.
 */
function durabilityPct(listing) {
	const max = Number(listing.item?.maxDurability) || 0;
	if (max <= 0) return 0;
	const dmg = Math.min(Math.max(Number(listing.item?.damage) || 0, 0), max);
	const left = Math.round(((max - dmg) / max) * 99);
	// Clamp to 1: a 0 would read as "no durability" and hide the bar on an item
	// that is merely almost broken.
	return Math.max(1, Math.min(99, left));
}

/** Lore line describing wear, shown only for a damaged item. */
function durabilityLine(listing) {
	const max = Number(listing.item?.maxDurability) || 0;
	// max <= 0 means this item type has no durability at all (a block, a
	// resource, a stack of dirt), or - for a listing made before
	// maxDurability was recorded - it genuinely was not captured. Either
	// way there is nothing honest to print, so this must return early.
	//
	// BUG: this check used to be part of a combined guard along with
	// "dmg <= 0" (skip fresh items too). Removing the dmg half so a fresh
	// TOOL would still show "100%" accidentally dropped the max half as
	// well, so nothing returned early any more - every listing fell through
	// to the division below, including non-tools, producing a garbled
	// "Durability: NaN/0 (NaN%)" line on every single item shown.
	if (max <= 0) return [];

	// A fresh item (dmg = 0) is no longer excluded: the visual bar used to be
	// the always-on wear signal, and it is gone now (its clip-width math had
	// no confirmed working implementation - see chest_server_form.json's
	// comment_durability), so this text line is the only one left. A
	// full-durability tool should say so explicitly rather than showing
	// nothing, which reads as "unknown" rather than "new".
	const dmg = Math.min(Math.max(Number(listing.item?.damage) || 0, 0), max);
	const left = Math.max(0, max - dmg);
	const pct = Math.round((left / max) * 100);
	const colour = pct > 60 ? '§a' : pct > 25 ? '§e' : '§c';
	return [`§7Durability: ${colour}${left}§7/§f${max} §7(${pct}%)`];
}

/** Format a number with commas, e.g. 1234567 → "1,234,567" */
function fmtNum(n) {
	return n.toLocaleString();
}

/** Generate a short unique ID */
function genId() {
	return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/** Find a connected player by name */
function findPlayer(name) {
	return world.getPlayers().find(p => p.name === name) ?? null;
}

/** Add money to an offline seller's pending payout bucket */
function addPendingPayout(sellerName, amount) {
	const key = 'sah:pending:' + sellerName;
	let pending = 0;
	try { pending = parseInt(world.getDynamicProperty(key) ?? '0') || 0; } catch {}
	try { world.setDynamicProperty(key, String(pending + amount)); } catch {}
}

/** Check if a player is an admin (has the "op" tag) */
function isAdmin(player) {
	return player.hasTag('op');
}

// ───────────────────────────────────────────────────────────────────
//  ╔══════════════════════════════════════╗
//  ║   /ah  –  AUCTION HOUSE BROWSER     ║
//  ╚══════════════════════════════════════╝
// ───────────────────────────────────────────────────────────────────

/**
 * Opens the 54-slot chest UI showing current listings.
 * @param {Player} player
 * @param {number} page - 0-based page index
 */
function openAH(player, page = 0) {
	system.run(() => {
		const sortMode   = getSortMode(player);
		const listings   = sortListings(getListings(), sortMode);
		const total      = listings.length;
		const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
		page = Math.max(0, Math.min(page, totalPages - 1));

		const form = new ChestFormData(54);
		form.title(`§l§6Auction House §r§7- Page ${page + 1}/${totalPages} (${total})`);

		const pageStart = page * ITEMS_PER_PAGE;

		// ── Slots 0-44: listings or empty filler ──
		for (let i = 0; i < ITEMS_PER_PAGE; i++) {
			const listing = listings[pageStart + i];

			if (!listing) {
				// Empty slot — invisible filler (no text shown in hover)
				form.button(i, '§8', [], FILLER_GREY, 1);
				continue;
			}

			const name   = getDisplayName(listing);
			const desc   = [
				`§7Seller: §f${listing.seller}`,
				`§7Price:  §a$${fmtNum(listing.price)}`,
				`§7Qty:    §f×${listing.item.amount}`,
				...durabilityLine(listing),
				...enchantLines(listing),
			];
			if (listing.description) desc.push(`§7§o"${listing.description}"`);
			desc.push('§8Click to purchase');

			form.button(i, `§f${name}`, desc, listing.item.typeId,
				Math.min(listing.item.amount, 99),
				durabilityPct(listing), isEnchanted(listing));
		}

		// ── Row 5 (slots 45-53): navigation bar ──
		for (let i = 45; i <= 53; i++) {
			form.button(i, '§8', [], FILLER_BLACK, 1);
		}

		if (page > 0) {
			form.button(PREV_SLOT, '§a◀ Previous', [`§7← Page ${page}/${totalPages}`], 'minecraft:arrow', 1);
		}

		form.button(LIST_SLOT, '§eList an Item',
			['§7Sell what you are holding'], 'minecraft:oak_sign', 1);

		form.button(BACK_SLOT, '§cBack',
			['§7Return to the Main Menu'],
			'minecraft:nether_star', 1);

		form.button(SORT_SLOT, '§eSort: §f' + sortMode,
			['§7Click to change'], 'minecraft:hopper', 1);

		if (page < totalPages - 1) {
			form.button(NEXT_SLOT, '§a▶ Next', [`§7→ Page ${page + 2}/${totalPages}`], 'minecraft:arrow', 1);
		}

		form.show(player).then(res => {
			if (res.canceled || res.selection === undefined) return;

			const slot = res.selection;

			// ── Navigation ──
			if (slot === PREV_SLOT && page > 0)              { openAH(player, page - 1); return; }
			if (slot === NEXT_SLOT && page < totalPages - 1) { openAH(player, page + 1); return; }
			if (slot === LIST_SLOT)                          { openSellMenu(player);     return; }
			if (slot === SORT_SLOT) {
				cycleSortMode(player);
				openAH(player, 0); // sort changes the order, so page 0 is the only page that still makes sense
				return;
			}
			if (slot === BACK_SLOT) {
				system.run(() => {
					try {
						player.runCommand('team:menu');
					} catch (e) {
						// The teams pack is a separate pack and may not be enabled in
						// this world; closing is a safe fallback rather than an error.
					}
				});
				return;
			}
			if (slot >= 45)                                   { openAH(player, page);     return; } // rest of nav row

			// ── Item slot ──
			const listing = listings[pageStart + slot];
			if (!listing) { openAH(player, page); return; } // empty filler slot

			openPurchaseConfirm(player, listing, page);
		}).catch(() => {});
	});
}

// ───────────────────────────────────────────────────────────────────
//  PURCHASE FLOW
// ───────────────────────────────────────────────────────────────────

function openPurchaseConfirm(player, listing, page) {
	system.run(() => {
		const name      = getDisplayName(listing);
		const balance   = getMoney(player);
		const canAfford = balance >= listing.price;
		const isSelf    = listing.seller === player.name;

		let status;
		if (isSelf)         status = '§e⚠ This is your own listing.';
		else if (canAfford) status = '§a✔ You can afford this!';
		else                status = `§c✘ Need §a$${fmtNum(listing.price - balance)} §cmore.`;

		const bodyLines = [
			`§fItem: §e${name}`,
			`§fQty:  §e×${listing.item.amount}`,
			`§fSeller: §e${listing.seller}`,
			`§fPrice: §a$${fmtNum(listing.price)}`,
		];
		// Condition and enchantments are most of what a tool is worth, so they
		// belong on the screen where the money is actually committed, not only in
		// hover text.
		bodyLines.push(...durabilityLine(listing));
		const ench = enchantLines(listing);
		if (ench.length) bodyLines.push('', '§fEnchantments:', ...ench);
		if (listing.description) bodyLines.push(`§7"§f${listing.description}§7"`);
		bodyLines.push('', `§fYour balance: §a$${fmtNum(balance)}`, status);

		const canBuy     = canAfford && !isSelf;
		// Your own listing offers a way back out instead of a dead "cannot buy"
		// button - the only thing a seller wants from this screen.
		const buyLabel   = isSelf ? '§e⟲ Take Off Auction'
			: (canBuy ? '§a✔ Buy Now' : '§8✖ Cannot Buy');

		new ActionFormData()
			.title(isSelf ? `§l§eYour listing: §r§e${name}` : `§l§6Buy: §r§e${name}`)
			.body(bodyLines.join('\n'))
			.button(buyLabel)
			.button('§c✖ Cancel')
			.show(player)
			.then(res => {
				if (res.canceled || res.selection !== 0) {
					openAH(player, page);
					return;
				}
				if (isSelf) {
					reclaimListing(player, listing, page);
					return;
				}
				if (!canBuy) {
					openAH(player, page);
					return;
				}
				processPurchase(player, listing, page);
			})
			.catch(() => {});
	});
}

/**
 * A seller taking their own listing back off the auction house.
 *
 * The item is handed over BEFORE the listing is deleted. Doing it the other way
 * round - as the admin remove path does - destroys the item outright if the
 * inventory turns out to be full, because by then there is no listing left to
 * put it back in.
 */
function reclaimListing(player, listing, page) {
	system.run(() => {
		const listings = getListings();
		const idx      = listings.findIndex(l => l.id === listing.id);

		if (idx === -1) {
			player.sendMessage('§c[AH] That listing is gone - it may have just sold.');
			openAH(player, page);
			return;
		}

		const actual = listings[idx];
		if (actual.seller !== player.name) {
			player.sendMessage('§c[AH] That is not your listing.');
			openAH(player, page);
			return;
		}

		const container = player.getComponent('inventory')?.container;
		if (!container) {
			player.sendMessage('§c[AH] Could not read your inventory.');
			openAH(player, page);
			return;
		}
		if (container.emptySlotsCount <= 0) {
			player.sendMessage('§c[AH] Your inventory is full - free a slot first.');
			openAH(player, page);
			return;
		}

		let item;
		try {
			item = deserializeItem(actual.item);
			container.addItem(item);
		} catch (e) {
			console.error('[SAH] reclaim failed:', e);
			player.sendMessage('§c[AH] Something went wrong - your listing was left alone.');
			openAH(player, page);
			return;
		}

		// Only now that the item is safely in hand does the listing go.
		listings.splice(idx, 1);
		saveListings(listings);

		player.sendMessage(
			`§a[AH] Took §e${getDisplayName(actual)}§a off the auction house.`
		);
		openAH(player, page);
	});
}

function processPurchase(player, listing, page) {
	system.run(() => {
		// Re-read listings to guard against race conditions
		const listings = getListings();
		const idx      = listings.findIndex(l => l.id === listing.id);

		if (idx === -1) {
			player.sendMessage('§c[AH] This listing is no longer available.');
			openAH(player, page);
			return;
		}

		const actual = listings[idx];

		if (actual.seller === player.name) {
			player.sendMessage('§c[AH] You cannot buy your own listing.');
			openAH(player, page);
			return;
		}

		const balance = getMoney(player);
		if (balance < actual.price) {
			player.sendMessage(`§c[AH] Not enough money. Need §a$${fmtNum(actual.price)}§c, have §a$${fmtNum(balance)}§c.`);
			openAH(player, page);
			return;
		}

		// Check inventory space
		const container = player.getComponent('inventory')?.container;
		if (!container) { player.sendMessage('§c[AH] Could not access your inventory.'); return; }

		let hasSpace = false;
		for (let i = 0; i < container.size; i++) {
			if (!container.getItem(i)) { hasSpace = true; break; }
		}
		if (!hasSpace) {
			player.sendMessage('§c[AH] Your inventory is full!');
			openAH(player, page);
			return;
		}

		// ── Deduct money from buyer ──
		changeMoney(player, -actual.price);

		// ── Pay seller (or queue for offline payout) ──
		const seller = findPlayer(actual.seller);
		const name   = getDisplayName(actual);
		if (seller) {
			changeMoney(seller, actual.price);
			seller.sendMessage(
				`§a[AH] §f${player.name} bought your §e${name}§f for §a$${fmtNum(actual.price)}§f!`
			);
		} else {
			addPendingPayout(actual.seller, actual.price);
		}

		// ── Give item to buyer ──
		try {
			const item = deserializeItem(actual.item);
			container.addItem(item);
		} catch (e) {
			console.error('[SAH] Error giving item:', e);
			// Refund
			changeMoney(player, actual.price);
			player.sendMessage('§c[AH] Error restoring item. Purchase refunded.');
			return;
		}

		// ── Remove listing ──
		listings.splice(idx, 1);
		saveListings(listings);

		player.sendMessage(`§a[AH] Purchased §e${name} ×${actual.item.amount}§a for §a$${fmtNum(actual.price)}§a!`);

		// Re-open browser at the same page (clamp in case last item on that page was bought)
		openAH(player, page);
	});
}

// ───────────────────────────────────────────────────────────────────
//  ╔══════════════════════════════════════╗
//  ║   /ahsell  –  LIST AN ITEM          ║
//  ╚══════════════════════════════════════╝
// ───────────────────────────────────────────────────────────────────

/**
 * Where the item being sold lives, and how to read/remove it - so the rest of
 * openSellMenu does not care whether it came from the main hand (the original,
 * still-default path) or was found by name in the inventory (new: see
 * findHeldOrPrompt below). Both expose the same shape.
 */
function mainhandSource(player) {
	const equip = player.getComponent('equippable');
	const item = equip?.getEquipment(EquipmentSlot.Mainhand);
	if (!item) return null;
	return {
		item,
		remove(qty) {
			const fresh = player.getComponent('equippable')?.getEquipment(EquipmentSlot.Mainhand);
			if (!fresh || fresh.typeId !== item.typeId) return false; // changed mid-flow
			if (qty >= fresh.amount) {
				equip.setEquipment(EquipmentSlot.Mainhand, undefined);
			} else {
				fresh.amount = fresh.amount - qty;
				equip.setEquipment(EquipmentSlot.Mainhand, fresh);
			}
			return true;
		},
	};
}

function containerSlotSource(player, slotIndex, expectedTypeId) {
	const container = player.getComponent('inventory')?.container;
	if (!container) return null;
	const item = container.getItem(slotIndex);
	if (!item || item.typeId !== expectedTypeId) return null;
	return {
		item,
		remove(qty) {
			const fresh = container.getItem(slotIndex);
			if (!fresh || fresh.typeId !== expectedTypeId) return false; // changed mid-flow
			if (qty >= fresh.amount) {
				container.setItem(slotIndex, undefined);
			} else {
				fresh.amount = fresh.amount - qty;
				container.setItem(slotIndex, fresh);
			}
			return true;
		},
	};
}

function promptItemName(player) {
	new ModalFormData()
		.title('§l§6Find Item to Sell')
		.textField('§fItem name', 'e.g. diamond sword', { defaultValue: '' })
		.show(player)
		.then(res => {
			if (res.canceled) return;
			const query = (res.formValues?.[0] ?? '').trim();
			system.run(() => resolveInventorySearch(player, query));
		})
		.catch(() => {});
}

/** Every stack in the inventory container, paired with its slot index. */
function inventoryStacks(player) {
	const container = player.getComponent('inventory')?.container;
	if (!container) return [];
	const out = [];
	for (let i = 0; i < container.size; i++) {
		const item = container.getItem(i);
		if (item) out.push({ slot: i, item });
	}
	return out;
}

function resolveInventorySearch(player, query) {
	if (!query) { promptItemName(player); return; }

	const needle = query.toLowerCase().replace(/\s+/g, '_').replace(/^minecraft:/, '');
	const stacks = inventoryStacks(player);

	// One entry per distinct typeId that matches, so five stacks of the same
	// sword count as one match, not five.
	const byType = new Map();
	for (const { slot, item } of stacks) {
		const bare = item.typeId.replace(/^[a-z0-9_.]+:/i, '').toLowerCase();
		if (bare.includes(needle) && !byType.has(item.typeId)) {
			byType.set(item.typeId, slot);
		}
	}

	if (byType.size === 0) {
		const form = new ChestFormData(27);
		form.title('§l§cNo Match');
		for (let i = 0; i < 27; i++) form.button(i, '§8', [], FILLER_BLACK, 1);
		form.button(13, '§cNo item matching "' + query + '"',
			['§7Nothing in your inventory matches.', '§7Click to try again.'],
			'minecraft:barrier', 1);
		form.show(player).then(res => {
			if (res.canceled) return;
			// Only one real destination now that there is no intermediate
			// screen to go "back" to - any click here means try the search
			// again.
			system.run(() => promptItemName(player));
		}).catch(() => {});
		return;
	}

	if (byType.size > 1) {
		const form = new ChestFormData(54);
		form.title('§l§eMultiple Matches');
		for (let i = 0; i < 54; i++) form.button(i, '§8', [], FILLER_BLACK, 1);
		const entries = [...byType.entries()];
		entries.slice(0, 45).forEach(([typeId, slot], i) => {
			const name = getDisplayName({ item: { typeId } });
			form.button(i, '§e' + name, ['§7Click to sell this one'], typeId, 1);
		});
		form.button(49, '§7Back to search', [], 'minecraft:arrow', 1);
		form.show(player).then(res => {
			if (res.canceled) return;
			if (res.selection === 49) { system.run(() => promptItemName(player)); return; }
			const picked = entries[res.selection];
			if (!picked) { system.run(() => promptItemName(player)); return; }
			// Deferred: this form is still closing, and the sell prompt it opens
			// next is a ModalFormData - opened in the same tick it would be
			// silently dropped, the same way every other chest-to-form
			// transition in this codebase has to be.
			system.run(() => openSellMenu(player, containerSlotSource(player, picked[1], picked[0])));
		}).catch(() => {});
		return;
	}

	// Exactly one distinct item type matched - sell it directly.
	const [typeId, slot] = [...byType.entries()][0];
	openSellMenu(player, containerSlotSource(player, slot, typeId));
}

/**
 * @param {object} [source] - result of mainhandSource()/containerSlotSource().
 *   Omitted (the /ahsell and List-an-Item paths) means "use whatever is in the
 *   main hand", going straight to the name-search prompt instead of a chat
 *   message if nothing is held - a message would never be seen while a menu
 *   is open. No intermediate chest screen: it had nothing on it worth seeing
 *   before typing, just an extra click.
 */
function openSellMenu(player, source) {
	system.run(() => {
		if (source === undefined) source = mainhandSource(player);

		if (!source) {
			promptItemName(player);
			return;
		}

		const held = source.item;

		if (getBannedItems().includes(held.typeId)) {
			const form = new ChestFormData(27);
			form.title('§l§cBanned Item');
			for (let i = 0; i < 27; i++) form.button(i, '§8', [], FILLER_BLACK, 1);
			form.button(13, '§c' + getDisplayName({ item: held }),
				['§7This item is banned from the', '§7Auction House.'],
				'minecraft:barrier', 1);
			form.show(player).catch(() => {});
			return;
		}

		// Shulker boxes are blocked outright: the scripting API cannot read what
		// is stored inside one, so a listed box would arrive empty and silently
		// destroy its contents.
		if (/shulker_box$/.test(held.typeId)) {
			const form = new ChestFormData(27);
			form.title('§l§cCannot List');
			for (let i = 0; i < 27; i++) form.button(i, '§8', [], FILLER_BLACK, 1);
			form.button(13, '§cShulker boxes cannot be listed',
				['§7Their contents would be lost -', '§7the game cannot read what is inside.'],
				'minecraft:barrier', 1);
			form.show(player).catch(() => {});
			return;
		}

		const settings = getSettings();
		const listings = getListings();
		const myCount  = listings.filter(l => l.seller === player.name).length;

		if (myCount >= settings.maxPerPlayer) {
			player.sendMessage(
				`§c[AH] You have reached your listing limit (${myCount}/${settings.maxPerPlayer}). ` +
				`Remove a listing or wait for a sale before adding more.`
			);
			return;
		}

		// Friendly name for the title. Same rule as the listing grid: derived from
		// the typeId so the seller confirms what the item really is, and so an
		// add-on item does not read "oresplus:ruby sword".
		const friendlyName = getDisplayName({ item: held });

		// held is a live ItemStack, not a stored listing, so read its
		// enchantments through the component rather than the serialised field.
		const heldEnchants = serializeItem(held).enchants;
		const enchSuffix = heldEnchants.length
			? ` §7(${heldEnchants.length} ench.)`
			: '';

		const balance = getMoney(player);

		new ModalFormData()
			.title(`§l§6Sell: §e${friendlyName}${enchSuffix}`)
			.textField(
				`§fPrice §7(min $${fmtNum(settings.minPrice)}, max $${fmtNum(settings.maxPrice)})`,
				'e.g. 500',
				{ defaultValue: `${settings.minPrice}` }
			)
			.textField(
				`§fQuantity §7(you hold x${held.amount})`,
				`1 - ${held.amount}`,
				{ defaultValue: `${held.amount}` }
			)
			.textField(
				'§fDescription §7(optional, max 20 characters)',
				'Short description...',
				{ defaultValue: '' }
			)
			.show(player)
			.then(res => {
				if (res.canceled) return;

				const [priceStr, qtyStr, rawDesc] = res.formValues;

				// ── Validate price ──
				const price = parseInt(priceStr);
				if (isNaN(price) || price < settings.minPrice || price > settings.maxPrice) {
					player.sendMessage(
						`§c[AH] Invalid price. Must be between §a$${fmtNum(settings.minPrice)}` +
						` §cand §a$${fmtNum(settings.maxPrice)}§c.`
					);
					return;
				}

				// ── Validate quantity ──
				const qty = parseInt(qtyStr);
				if (isNaN(qty) || qty < 1 || qty > held.amount) {
					player.sendMessage(`§c[AH] Invalid quantity. Must be 1–${held.amount}.`);
					return;
				}

				// ── Validate description ──
				const desc = (rawDesc ?? '').trim();
				if (desc.length > 20) {
					player.sendMessage(`§c[AH] Description too long (${desc.length}/20 chars).`);
					return;
				}

				// ── Create listing ──
				const itemData   = serializeItem(held);
				itemData.amount  = qty;

				const listing = {
					id          : genId(),
					seller      : player.name,
					item        : itemData,
					price,
					description : desc,
					listedAt    : Date.now(),
				};

				// Store BEFORE taking the item. The old order removed it first and
				// only then saved, so a failed write - which is what happens when
				// storage is full - destroyed the item with nothing listed for it.
				// Re-read before pushing to avoid overwriting concurrent changes.
				const current = getListings();
				current.push(listing);
				if (!saveListings(current)) {
					player.sendMessage(
						'§c[AH] The auction house is full and your listing could not be saved. ' +
						'Your item was not taken.'
					);
					return;
				}

				// ── Remove from wherever it came from ──
				// Re-checks the live item itself (source.remove re-reads it), so this
				// replaces the old separate "has it changed" check above rather than
				// needing both.
				if (!source.remove(qty)) {
					player.sendMessage('§c[AH] That item changed or is gone - please try again.');
					return;
				}

				player.sendMessage(
					`§a[AH] Listed §e${friendlyName} ×${qty}§a for §a$${fmtNum(price)}§a! ` +
					`(${myCount + 1}/${settings.maxPerPlayer} slots used)`
				);
			})
			.catch(() => {});
	});
}

// ───────────────────────────────────────────────────────────────────
//  ╔══════════════════════════════════════╗
//  ║   /ahmenu  –  ADMIN PANEL           ║
//  ╚══════════════════════════════════════╝
// ───────────────────────────────────────────────────────────────────

function openAdminMenu(player) {
	system.run(() => {
		const settings = getSettings();
		const listings = getListings();

		new ActionFormData()
			.title('§l§cAH Admin Panel')
			.body(
				`§fActive listings:    §e${listings.length}\n` +
				`§fPer-player limit:   §e${settings.maxPerPlayer}\n` +
				`§fPrice range:        §a$${fmtNum(settings.minPrice)} §7– §a$${fmtNum(settings.maxPrice)}\n` +
				`§fBanned items:       §c${getBannedItems().length}`
			)
			.button('§cRemove a Listing')
			.button('§eSet Price Limits')
			.button('§bSet Per-Player Listing Limit')
			.button('§4Ban an Item')
			.button('§6Banned Items')
			.show(player)
			.then(res => {
				if (res.canceled || res.selection === undefined) return;
				switch (res.selection) {
					case 0: adminOpenRemovePicker(player);       break;
					case 1: adminOpenPriceLimitForm(player);     break;
					case 2: adminOpenListingLimitForm(player);   break;
					case 3: adminOpenBanItemForm(player);        break;
					case 4: adminOpenBannedItemsList(player);    break;
				}
			})
			.catch(() => {});
	});
}

// ── Banned items ──────────────────────────────────────────────────

function adminOpenBanItemForm(player) {
	system.run(() => {
		// Prefill from whatever is in hand: typing a full namespaced id from
		// memory is the fiddly part, and the item you want to ban is usually the
		// one you are holding.
		let held = '';
		try {
			held = player.getComponent('equippable')
				?.getEquipment(EquipmentSlot.Mainhand)?.typeId ?? '';
		} catch { /* nothing held */ }

		new ModalFormData()
			.title('§l§4Ban an Item')
			.textField(
				'§fItem ID to ban\n§7(e.g. minecraft:diamond_sword)',
				'minecraft:diamond_sword',
				{ defaultValue: held }
			)
			.show(player)
			.then(res => {
				if (res.canceled) { openAdminMenu(player); return; }

				const raw = (res.formValues[0] ?? '').trim().toLowerCase();
				if (!raw) {
					player.sendMessage('§c[AH] You must enter an item ID.');
					openAdminMenu(player);
					return;
				}
				if (!/^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(raw)) {
					player.sendMessage(
						'§c[AH] Invalid item ID. Use the full id, e.g. §fminecraft:diamond_sword§c.'
					);
					openAdminMenu(player);
					return;
				}

				const banned = getBannedItems();
				if (banned.includes(raw)) {
					player.sendMessage(`§e[AH] §f${raw}§e is already banned.`);
					openAdminMenu(player);
					return;
				}

				banned.push(raw);
				saveBannedItems(banned);

				// Existing listings are left alone deliberately: pulling them would
				// either destroy the item or need a return path for offline sellers.
				// The ban stops new listings; remove any stragglers by hand.
				const live = getListings().filter(l => l.item.typeId === raw).length;
				player.sendMessage(
					`§a[AH] Banned §e${raw}§a from being listed.` +
					(live ? ` §7(${live} already listed - remove those manually.)` : '')
				);
				openAdminMenu(player);
			})
			.catch(() => {});
	});
}

function adminOpenBannedItemsList(player) {
	system.run(() => {
		const banned = getBannedItems();

		if (!banned.length) {
			player.sendMessage('§e[AH] No items are currently banned.');
			openAdminMenu(player);
			return;
		}

		const form = new ActionFormData()
			.title('§l§6Banned Items')
			.body(`§7${banned.length} item(s) banned. Select one to unban it:`);

		for (const typeId of banned) {
			form.button(`§c${realItemName(typeId)}\n§7${typeId}`);
		}

		form.show(player)
			.then(res => {
				if (res.canceled || res.selection === undefined) { openAdminMenu(player); return; }
				adminConfirmUnban(player, banned[res.selection]);
			})
			.catch(() => {});
	});
}

function adminConfirmUnban(player, typeId) {
	system.run(() => {
		new ActionFormData()
			.title('§l§6Confirm Unban')
			.body(`Unban §e${typeId}§r and allow it to be listed again?`)
			.button('§aUnban')
			.button('§7Cancel')
			.show(player)
			.then(res => {
				if (res.canceled || res.selection !== 0) { adminOpenBannedItemsList(player); return; }

				const banned = getBannedItems();
				const idx    = banned.indexOf(typeId);
				if (idx === -1) {
					player.sendMessage('§c[AH] That item is no longer on the banned list.');
					openAdminMenu(player);
					return;
				}

				banned.splice(idx, 1);
				saveBannedItems(banned);

				player.sendMessage(`§a[AH] Unbanned §e${typeId}§a.`);
				adminOpenBannedItemsList(player);
			})
			.catch(() => {});
	});
}

// ── Remove a listing ──────────────────────────────────────────────

function adminOpenRemovePicker(player) {
	system.run(() => {
		const listings = getListings();

		if (!listings.length) {
			player.sendMessage('§c[AH] There are no active listings to remove.');
			openAdminMenu(player);
			return;
		}

		const form = new ActionFormData()
			.title('§l§cRemove Listing')
			.body('§7Select the listing you want to remove:');

		for (const l of listings) {
			const name = getDisplayName(l);
			form.button(`§f${name}§r\n§7${l.seller} · §a$${fmtNum(l.price)} §7· ×${l.item.amount}`);
		}

		form.show(player)
			.then(res => {
				if (res.canceled || res.selection === undefined) { openAdminMenu(player); return; }
				adminConfirmRemove(player, listings[res.selection]);
			})
			.catch(() => {});
	});
}

function adminConfirmRemove(player, listing) {
	system.run(() => {
		const name = getDisplayName(listing);

		new ActionFormData()
			.title('§l§cConfirm Removal')
			.body(
				`Are you sure you want to remove this listing?\n\n` +
				`§fItem:   §e${name}\n` +
				`§fSeller: §e${listing.seller}\n` +
				`§fPrice:  §a$${fmtNum(listing.price)}\n` +
				`§fQty:    §e×${listing.item.amount}\n\n` +
				`§7If the seller is online the item will be returned to them.`
			)
			.button('§cRemove')
			.button('§7Cancel')
			.show(player)
			.then(res => {
				if (res.canceled || res.selection !== 0) { openAdminMenu(player); return; }
				adminDoRemove(player, listing);
			})
			.catch(() => {});
	});
}

function adminDoRemove(player, listing) {
	system.run(() => {
		const listings = getListings();
		const idx      = listings.findIndex(l => l.id === listing.id);

		if (idx === -1) {
			player.sendMessage('§c[AH] Listing not found (may have already been sold/removed).');
			openAdminMenu(player);
			return;
		}

		const removed = listings.splice(idx, 1)[0];
		saveListings(listings);

		// Return item to seller if they're online
		const seller = findPlayer(removed.seller);
		if (seller) {
			try {
				const item = deserializeItem(removed.item);
				seller.getComponent('inventory')?.container?.addItem(item);
				seller.sendMessage(
					`§e[AH] §fAn admin removed your listing for §e${getDisplayName(removed)}§f. ` +
					`The item has been returned to your inventory.`
				);
			} catch (e) {
				console.error('[SAH] Error returning item to seller:', e);
			}
		}

		player.sendMessage(
			`§a[AH] Removed §e${getDisplayName(removed)}§a ` +
			`(listed by §e${removed.seller}§a).`
		);
		openAdminMenu(player);
	});
}

// ── Set price limits ──────────────────────────────────────────────

function adminOpenPriceLimitForm(player) {
	system.run(() => {
		const s = getSettings();

		new ModalFormData()
			.title('§l§e Set Price Limits')
			.textField('§fMinimum listing price', 'e.g. 1',       { defaultValue: `${s.minPrice}` })
			.textField('§fMaximum listing price', 'e.g. 1000000', { defaultValue: `${s.maxPrice}` })
			.show(player)
			.then(res => {
				if (res.canceled) { openAdminMenu(player); return; }

				const min = parseInt(res.formValues[0]);
				const max = parseInt(res.formValues[1]);

				if (isNaN(min) || min < 0) {
					player.sendMessage('§c[AH] Invalid minimum price.');
					openAdminMenu(player);
					return;
				}
				if (isNaN(max) || max <= min) {
					player.sendMessage('§c[AH] Maximum price must be greater than minimum price.');
					openAdminMenu(player);
					return;
				}

				const settings   = getSettings();
				settings.minPrice = min;
				settings.maxPrice = max;
				saveSettings(settings);

				player.sendMessage(`§a[AH] Price range updated: §e$${fmtNum(min)} §a– §e$${fmtNum(max)}§a.`);
				openAdminMenu(player);
			})
			.catch(() => {});
	});
}

// ── Set per-player listing limit ──────────────────────────────────

function adminOpenListingLimitForm(player) {
	system.run(() => {
		const s = getSettings();

		new ModalFormData()
			.title('§l§b Set Listing Limit')
			.textField(
				'§fMax active listings per player\n§7(players already over-limit cannot add new listings)',
				'e.g. 5',
				{ defaultValue: `${s.maxPerPlayer}` }
			)
			.show(player)
			.then(res => {
				if (res.canceled) { openAdminMenu(player); return; }

				const val = parseInt(res.formValues[0]);
				if (isNaN(val) || val < 1) {
					player.sendMessage('§c[AH] Limit must be at least 1.');
					openAdminMenu(player);
					return;
				}

				const settings      = getSettings();
				settings.maxPerPlayer = val;
				saveSettings(settings);

				player.sendMessage(`§a[AH] Per-player listing limit set to §e${val}§a.`);
				openAdminMenu(player);
			})
			.catch(() => {});
	});
}

// ───────────────────────────────────────────────────────────────────
// OFFLINE PAYOUT — delivered when seller next joins
// ───────────────────────────────────────────────────────────────────

if (typeof world.afterEvents?.playerJoin?.subscribe === 'function') {
world.afterEvents.playerJoin.subscribe(({ playerName }) => {
	// Small delay to ensure the player entity is fully initialised
	system.runTimeout(() => {
		const player = findPlayer(playerName);
		if (!player) return;

		const key = 'sah:pending:' + playerName;
		let pending = 0;
		try { pending = parseInt(world.getDynamicProperty(key) ?? '0') || 0; } catch {}

		if (pending > 0) {
			changeMoney(player, pending);
			try { world.setDynamicProperty(key, '0'); } catch {}
			player.sendMessage(
				`§a[AH] Welcome back! You earned §a$${fmtNum(pending)}§a from sales while you were offline.`
			);
		}
	}, 60); // 3-second buffer (60 ticks)
});
} // end playerJoin guard

// ───────────────────────────────────────────────────────────────────
//  VANILLA FALLBACK MENU  (/sah:ahlist)
//  Plain ActionFormData — no resource pack needed.
//  Each button: "Item Name  x{qty}  $price\n  Seller: name"
// ───────────────────────────────────────────────────────────────────

const VANILLA_PER_PAGE = 10; // buttons per page in the vanilla list

function openAH_vanilla(player, page = 0) {
	system.run(() => {
		const listings   = getListings();
		const total      = listings.length;
		const totalPages = Math.max(1, Math.ceil(total / VANILLA_PER_PAGE));
		page = Math.max(0, Math.min(page, totalPages - 1));

		const pageStart  = page * VANILLA_PER_PAGE;
		const pageItems  = listings.slice(pageStart, pageStart + VANILLA_PER_PAGE);

		const form = new ActionFormData()
			.title(`§l§6Auction House §r§7(${page + 1}/${totalPages})`)
			.body(
				`§7${total} listing${total !== 1 ? 's' : ''} total` +
				(total === 0 ? '\n§8No items are currently for sale.' : '')
			);

		// Track which buttons are real listings vs nav buttons
		const buttonMap = []; // 'listing' | 'prev' | 'next'

		for (const listing of pageItems) {
			const name = getDisplayName(listing);
			form.button(
				`§e${name}  §fx${listing.item.amount}  §a$${fmtNum(listing.price)}\n` +
				`§fSeller: §b${listing.seller}` +
				(listing.description ? `  §f"§e${listing.description}§f"` : '')
			);
			buttonMap.push('listing');
		}

		if (page > 0) {
			form.button(`§a< Previous  §7(page ${page}/${totalPages})`);
			buttonMap.push('prev');
		}

		if (page < totalPages - 1) {
			form.button(`§a> Next  §7(page ${page + 2}/${totalPages})`);
			buttonMap.push('next');
		}

		form.show(player).then(res => {
			if (res.canceled || res.selection === undefined) return;

			const kind = buttonMap[res.selection];

			if (kind === 'prev') { openAH_vanilla(player, page - 1); return; }
			if (kind === 'next') { openAH_vanilla(player, page + 1); return; }

			// Listing button
			const listing = listings[pageStart + res.selection];
			if (!listing) { openAH_vanilla(player, page); return; }

			// Re-use the same purchase confirm flow
			openPurchaseConfirm_vanilla(player, listing, page);
		}).catch(() => {});
	});
}

function openPurchaseConfirm_vanilla(player, listing, page) {
	system.run(() => {
		const name      = getDisplayName(listing);
		const balance   = getMoney(player);
		const canAfford = balance >= listing.price;
		const isSelf    = listing.seller === player.name;

		let status;
		if (isSelf)         status = '§eThis is your own listing.';
		else if (canAfford) status = '§aYou can afford this!';
		else                status = `§cNeed $${fmtNum(listing.price - balance)} more.`;

		const bodyLines = [
			`§fItem:    §e${name}`,
			`§fQty:     §e×${listing.item.amount}`,
			`§fSeller:  §e${listing.seller}`,
			`§fPrice:   §a$${fmtNum(listing.price)}`,
		];
		if (listing.description) bodyLines.push(`§7"${listing.description}"`);
		bodyLines.push('', `§fYour balance: §a$${fmtNum(balance)}`, status);

		const canBuy = canAfford && !isSelf;

		new ActionFormData()
			.title(`§l§6Buy: §r§e${name}`)
			.body(bodyLines.join('\n'))
			.button(canBuy ? '§aBuy Now' : '§8Cannot Buy')
			.button('§cCancel')
			.show(player)
			.then(res => {
				if (res.canceled || res.selection !== 0 || !canBuy) {
					openAH_vanilla(player, page);
					return;
				}
				// Re-use existing purchase logic, return to vanilla list after
				processPurchase_vanilla(player, listing, page);
			})
			.catch(() => {});
	});
}

function processPurchase_vanilla(player, listing, page) {
	system.run(() => {
		const listings = getListings();
		const idx      = listings.findIndex(l => l.id === listing.id);

		if (idx === -1) {
			player.sendMessage('§c[AH] Listing no longer available.');
			openAH_vanilla(player, page);
			return;
		}

		const actual = listings[idx];

		if (actual.seller === player.name) {
			player.sendMessage('§c[AH] You cannot buy your own listing.');
			openAH_vanilla(player, page);
			return;
		}

		const balance = getMoney(player);
		if (balance < actual.price) {
			player.sendMessage(`§c[AH] Not enough money.`);
			openAH_vanilla(player, page);
			return;
		}

		const container = player.getComponent('inventory')?.container;
		if (!container) { player.sendMessage('§c[AH] Cannot access inventory.'); return; }

		let hasSpace = false;
		for (let i = 0; i < container.size; i++) {
			if (!container.getItem(i)) { hasSpace = true; break; }
		}
		if (!hasSpace) {
			player.sendMessage('§c[AH] Inventory full!');
			openAH_vanilla(player, page);
			return;
		}

		changeMoney(player, -actual.price);

		const seller = findPlayer(actual.seller);
		const name   = getDisplayName(actual);
		if (seller) {
			changeMoney(seller, actual.price);
			seller.sendMessage(`§a[AH] §f${player.name} bought §e${name}§f for §a$${fmtNum(actual.price)}§f!`);
		} else {
			addPendingPayout(actual.seller, actual.price);
		}

		try {
			container.addItem(deserializeItem(actual.item));
		} catch {
			changeMoney(player, actual.price);
			player.sendMessage('§c[AH] Error giving item. Refunded.');
			return;
		}

		listings.splice(idx, 1);
		saveListings(listings);

		player.sendMessage(`§a[AH] Bought §e${name} x${actual.item.amount}§a for §a$${fmtNum(actual.price)}§a!`);
		openAH_vanilla(player, page);
	});
}

// ───────────────────────────────────────────────────────────────────
// STARTUP: COMMAND REGISTRATION  (v2.8.0 API)
// Commands appear as real slash commands with autocomplete.
// ───────────────────────────────────────────────────────────────────

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {

	// ── /ah ──────────────────────────────────────────────────────
	customCommandRegistry.registerCommand(
		{
			name             : 'sah:ah',
			description      : 'Browse the Auction House',
			permissionLevel  : CommandPermissionLevel.Any,
			cheatsRequired   : false,
			mandatoryParameters : [],
			optionalParameters  : [],
		},
		(origin) => {
			const player = origin.initiator ?? origin.sourceEntity;
			if (!(player instanceof Player))
				return { status: CustomCommandStatus.Failure, message: '§c[AH] Players only.' };
			openAH(player, 0);
			return { status: CustomCommandStatus.Success };
		}
	);

	// ── /ahsell ──────────────────────────────────────────────────
	customCommandRegistry.registerCommand(
		{
			name             : 'sah:ahsell',
			description      : 'List your held item on the Auction House',
			permissionLevel  : CommandPermissionLevel.Any,
			cheatsRequired   : false,
			mandatoryParameters : [],
			optionalParameters  : [],
		},
		(origin) => {
			const player = origin.initiator ?? origin.sourceEntity;
			if (!(player instanceof Player))
				return { status: CustomCommandStatus.Failure, message: '§c[AH] Players only.' };
			openSellMenu(player);
			return { status: CustomCommandStatus.Success };
		}
	);

	// ── /ahmenu (admin only) ─────────────────────────────────────
	customCommandRegistry.registerCommand(
		{
			name             : 'sah:ahmenu',
			description      : 'Open the Auction House admin panel [requires op tag]',
			permissionLevel  : CommandPermissionLevel.Any,
			cheatsRequired   : false,
			mandatoryParameters : [],
			optionalParameters  : [],
		},
		(origin) => {
			const player = origin.initiator ?? origin.sourceEntity;
			if (!(player instanceof Player))
				return { status: CustomCommandStatus.Failure, message: '§c[AH] Players only.' };
			if (!isAdmin(player))
				return { status: CustomCommandStatus.Failure, message: '§c[AH] You do not have permission to use this command.' };
			openAdminMenu(player);
			return { status: CustomCommandStatus.Success };
		}
	);

	// ── /ahlist — vanilla button-list (no resource pack needed) ──
	customCommandRegistry.registerCommand(
		{
			name             : 'sah:ahlist',
			description      : 'Browse the Auction House (no resource pack needed)',
			permissionLevel  : CommandPermissionLevel.Any,
			cheatsRequired   : false,
			mandatoryParameters : [],
			optionalParameters  : [],
		},
		(origin) => {
			const player = origin.initiator ?? origin.sourceEntity;
			if (!(player instanceof Player))
				return { status: CustomCommandStatus.Failure, message: '§c[AH] Players only.' };
			openAH_vanilla(player, 0);
			return { status: CustomCommandStatus.Success };
		}
	);

	// NOTE: world.scoreboard cannot be called here (early execution).
	// The money objective is created lazily on first use by ensureMoneyObjective().
	console.log('[SAH] Simple Auction House loaded.  Commands: /sah:ah | /sah:ahsell | /sah:ahmenu (op tag required)');
});
