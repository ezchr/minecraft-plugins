import { world } from '@minecraft/server';

/**
 * JSON storage that spans as many dynamic properties as the data needs.
 *
 * A single property caps at roughly 32 KB, which for the auction house worked
 * out at about 114 listings and for teams as few as 37 - and the failure was
 * silent: setDynamicProperty throws past the cap, the caller logged it, and the
 * write was simply lost after the seller's item had already been taken.
 *
 * The value is written as "<key>" holding the chunk count, plus "<key>:0",
 * "<key>:1", ... holding the string in CHUNK-sized pieces. Reading concatenates
 * them back. Chunks left over from a previous, longer write are cleared so they
 * cannot be picked up by a later read.
 *
 * Old single-property data is still readable: if the count property is missing
 * but the key itself holds a string, that string is returned as-is, so an
 * existing world keeps its listings and teams and is migrated on the next save.
 */

const CHUNK = 28_000;      // headroom under the ~32 KB per-property cap
const MAX_CHUNKS = 64;     // ~1.8 MB, far beyond any realistic use

/** Read a chunked value, falling back to the legacy single-property layout. */
export function readChunked(key, fallback) {
    try {
        const head = world.getDynamicProperty(key);

        // Legacy layout: the key itself holds the whole JSON string.
        if (typeof head === 'string') {
            return head.length ? JSON.parse(head) : fallback;
        }

        const count = typeof head === 'number' ? head : 0;
        if (count <= 0) return fallback;

        let json = '';
        for (let i = 0; i < count; i++) {
            const part = world.getDynamicProperty(`${key}:${i}`);
            if (typeof part !== 'string') {
                console.error(`[store] ${key} chunk ${i}/${count} missing; refusing partial data`);
                return fallback;
            }
            json += part;
        }
        return json.length ? JSON.parse(json) : fallback;
    } catch (error) {
        console.error(`[store] failed to read ${key}: ${error}`);
        return fallback;
    }
}

/**
 * Write a value across as many chunks as it needs.
 * @returns {boolean} true if it was stored, false if it was too large or failed -
 *   callers that are about to take something from a player should check this.
 */
export function writeChunked(key, value) {
    let json;
    try {
        json = JSON.stringify(value);
    } catch (error) {
        console.error(`[store] failed to serialise ${key}: ${error}`);
        return false;
    }

    const needed = Math.max(1, Math.ceil(json.length / CHUNK));
    if (needed > MAX_CHUNKS) {
        console.error(`[store] ${key} needs ${needed} chunks, over the ${MAX_CHUNKS} limit`);
        return false;
    }

    // How many chunks the previous write used, so the surplus can be cleared.
    const prevHead = world.getDynamicProperty(key);
    const prev = typeof prevHead === 'number' ? prevHead : 0;

    try {
        for (let i = 0; i < needed; i++) {
            world.setDynamicProperty(`${key}:${i}`, json.slice(i * CHUNK, (i + 1) * CHUNK));
        }
        // Count last: a reader that runs mid-write sees the old count and old
        // chunks rather than a count pointing at chunks that are not there yet.
        world.setDynamicProperty(key, needed);

        for (let i = needed; i < prev; i++) {
            world.setDynamicProperty(`${key}:${i}`, undefined);
        }
        return true;
    } catch (error) {
        console.error(`[store] failed to write ${key}: ${error}`);
        return false;
    }
}

/** Rough stored size in characters, for capacity warnings. */
export function chunkedSize(value) {
    try {
        return JSON.stringify(value).length;
    } catch {
        return 0;
    }
}
