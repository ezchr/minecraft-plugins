/**
 * Simple Auction House - forms.js
 * Provides ChestFormData: a wrapper around ActionFormData that triggers
 * the resource-pack chest-UI overlay via a specially-encoded title string.
 *
 * Usage:
 *   const form = new ChestFormData(54);
 *   form.title("My Chest");
 *   form.button(slot, itemName, itemDesc[], texture, stackSize, durability, enchanted);
 *   const res = await form.show(player);
 *   // res.selection === slot index that was clicked
 */

import { ActionFormData } from '@minecraft/server-ui';
import {
	custom_content, custom_content_keys,
	inventory_enabled, customItemCount,
	CHEST_UI_SIZES
} from './constants.js';
import { typeIdToDataId, typeIdToID } from './typeIds.js';

export class ChestFormData {
	#titleText;
	#buttonArray;

	constructor(size = 'small') {
		const sizing = CHEST_UI_SIZES.get(size) ?? ['§c§h§e§s§t§2§7§r', 27];
		this.#titleText   = { rawtext: [{ text: `${sizing[0]}` }] };
		this.#buttonArray = Array(sizing[1]).fill(null).map(() => ['', undefined]);
		this.slotCount    = sizing[1];
	}

	/** Append text to the chest title (shown above the grid). */
	title(text) {
		if (typeof text === 'string') {
			this.#titleText.rawtext.push({ text });
		} else if (typeof text === 'object') {
			if (text.rawtext) this.#titleText.rawtext.push(...text.rawtext);
			else              this.#titleText.rawtext.push(text);
		}
		return this;
	}

	/**
	 * Set a slot in the chest grid.
	 * @param {number} slot       - Slot index (0-based, left-to-right, top-to-bottom).
	 * @param {string|object} itemName - Display name (string or rawtext object).
	 * @param {Array}  itemDesc   - Array of description lines (strings or rawtext objects).
	 * @param {string} texture    - Minecraft typeId (e.g. "minecraft:diamond") or texture path.
	 * @param {number} stackSize  - Stack count shown on the slot (1-99).
	 * @param {number} durability - Durability ratio shown on the slot (0-99).
	 * @param {boolean} enchanted - Whether to show the enchant glint.
	 */
	button(slot, itemName, itemDesc = [], texture = '', stackSize = 1, durability = 0, enchanted = false) {
		const targetTexture = custom_content_keys.has(texture)
			? custom_content[texture]?.texture
			: texture;

		const ID = typeIdToDataId.get(targetTexture) ?? typeIdToID.get(targetTexture);

		const stackStr = String(Math.min(Math.max(stackSize, 1), 99)).padStart(2, '0');
		const durStr   = String(Math.min(Math.max(durability, 0), 99)).padStart(2, '0');

		// The resource pack reads this string by fixed character offsets:
		//   0-5 "stack#", 6-7 count, 8-11 "?u?#"-shaped padding, 12-13
		//   durability, 14+ NAME. Nothing past character 14 can be used for
		//   flags - it renders as part of the item's name (an earlier attempt
		//   at this drew "ench#1Reinforced Ruby Boots").
		//
		// Two characters of that 8-11 padding carry flags now:
		//   8  = 'e' enchanted / 'd' not          (was always 'd' of "dur#")
		//   9  = wear band for colouring the bar  (was always 'u' of "dur#")
		// Positions 10-11 stay the literal 'r#' so nothing else about the
		// layout has to change.
		//
		// The wear band used to be computed in the resource pack instead, by
		// comparing the durability number against a min/max with >= and <=.
		// Those operators have no precedent anywhere in vanilla's own shipped
		// UI - not one occurrence in any screen - and evaluating that
		// (three bands x up to 39 values, per slot, every frame the form is
		// open) is almost certainly why every chest menu using this pack
		// slowed down once that binding was added. Deciding the band here
		// instead costs one if/else in a language that actually has one, and
		// the resource pack only ever needs a single-character equality
		// check to read it back - the same proven pattern as the enchant flag.
		const enchFlag = enchanted ? 'e' : 'd';
		const dur = Math.min(Math.max(durability, 0), 99);
		const bandFlag = dur === 0 ? 'u' : dur > 60 ? 'h' : dur > 25 ? 'm' : 'l';

		let buttonRawtext = {
			rawtext: [{ text: `stack#${stackStr}${enchFlag}${bandFlag}r#${durStr}§r` }]
		};

		if (typeof itemName === 'string') {
			buttonRawtext.rawtext.push({ text: itemName ? `${itemName}§r` : '§r' });
		} else if (typeof itemName === 'object' && itemName?.rawtext) {
			buttonRawtext.rawtext.push(...itemName.rawtext, { text: '§r' });
		} else {
			return this; // invalid name, skip
		}

		if (Array.isArray(itemDesc)) {
			for (const line of itemDesc) {
				if (!line) continue;
				if (typeof line === 'string') {
					buttonRawtext.rawtext.push({ text: `\n${line}` });
				} else if (typeof line === 'object' && line.rawtext) {
					buttonRawtext.rawtext.push({ text: '\n' }, ...line.rawtext);
				}
			}
		}

		const numericId = ID === undefined
			? targetTexture
			: ((ID + (ID < 256 ? 0 : customItemCount())) * 65536) + (enchanted ? 32768 : 0);

		const clampedSlot = Math.max(0, Math.min(slot, this.slotCount - 1));
		this.#buttonArray[clampedSlot] = [buttonRawtext, numericId];
		return this;
	}

	/** Show the chest UI to a player. Returns the same Promise as ActionFormData.show(). */
	show(player) {
		const form = new ActionFormData().title(this.#titleText);
		for (const [text, icon] of this.#buttonArray) {
			form.button(text, icon?.toString() ?? '');
		}

		if (!inventory_enabled) return form.show(player);

		// Append the player's own inventory as extra buttons so the RP can mirror them.
		const container = player.getComponent('inventory')?.container;
		if (container) {
			for (let i = 0; i < container.size; i++) {
				const item = container.getItem(i);
				if (!item) { form.button('', ''); continue; }

				const typeId        = item.typeId;
				const tgt           = custom_content_keys.has(typeId) ? custom_content[typeId]?.texture : typeId;
				const ID            = typeIdToDataId.get(tgt) ?? typeIdToID.get(tgt);
				const durComp       = item.getComponent('durability');
				const durDamage     = durComp
					? Math.round((durComp.maxDurability - durComp.damage) / durComp.maxDurability * 99)
					: 0;
				const amount        = item.amount;
				const friendlyName  = typeId.replace(/.*(?<=:)/, '').replace(/_/g, ' ')
					.replace(/(^\w|\s\w)/g, m => m.toUpperCase());
				const loreText      = item.getLore().join('\n');

				const btnRaw = {
					rawtext: [{ text: `stack#${String(amount).padStart(2,'0')}dur#${String(durDamage).padStart(2,'0')}§r${friendlyName}` }]
				};
				if (loreText) btnRaw.rawtext.push({ text: loreText });

				const finalID = ID === undefined ? tgt : ((ID + (ID < 256 ? 0 : customItemCount())) * 65536);
				form.button(btnRaw, finalID.toString());
			}
		}

		return form.show(player);
	}
}
