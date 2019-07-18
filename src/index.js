const axios = require('axios');
const fs = require('fs-extra');

/**
 * `name - path` pairs
 */
const categories = {
	bandages: '/bandages',
	elixirs: '/elixirs',
	flasks: '/flasks',
	food_and_drinks: '/food-and-drinks',
	potions: '/potions',
	trinkets: '/trinkets',
}

const wowhead = axios.create({
	baseURL: 'https://www.wowhead.com',
});

const wowdb = axios.create({
	baseURL: 'https://www.wowdb.com/api',
})

/**
 * Pulls the html for the search categories from wowhead.
 * There is no search API.
 * wowdb normal search results are paged.
 */
async function prepareCategories() {
	try {
		for (const [category, path] of Object.entries(categories)) {
			console.log(`Preparing category ${category} ...`);
			const cache = `./cache/${category}`
			await fs.ensureDir(cache);

			const response = await wowhead.get(path);
			await fs.writeFile(`${cache}/${category}.html`, response.data);
		}
	} catch (error) {
		console.error(error);
	}
}

/**
 * Creates a JSON file with the item ids for every category
 * based on the html from wowhead.
 */
async function prepareCategoryLists() {
	try {
		for (const category of Object.keys(categories)) {
			const fileBase = `./cache/${category}/${category}`;
			const page = await fs.readFile(`${fileBase}.html`, 'utf-8');
			let data = page.match(/^var\slistviewitems.+$/m);
			data = data[0].match(/\"id\":\d+/g);
			data = data.map(entry => parseInt(entry.substring(5))).sort((a, b) => a - b);
			const info = {
				patch: '8.2.0', // TODO: proper patch info
				date: Date.now(),
				itemIDs: data,
			};
			await fs.writeJSON(`${fileBase}.json`, info);
		}
	} catch (error) {
		console.error(error);
	}
}

const itemNames = {}
/**
 * Maps auras to item ids based on data from wowdb
 */
async function prepareItemAndSpellData() {
	try {
		const store = new Map();
		for (const category of Object.keys(categories)) {
			const categoryData = new Map();
			const { items, cache: itemsCache } = await updateItemsCache(category);
			const { spells, cache: spellsCache } = await updateSpellsCache(category, items);

			for (const item of items) {
				itemNames[item.ID] = item.Name;
				for (const spell of item.Spells) {
					const auras = getAurasForItem(spell.SpellID, spells);

					if (Object.keys(auras).length) {
						itemsCache.delete(item.ID);
						categoryData.set(item.ID, auras);
					}
				}
			}

			if (itemsCache.size > 0) {
				console.warn(`No auras found for ${category}: ${[...itemsCache]}`);
			}

			// covert a map to object ...
			let output = [...categoryData].reduce((acc, value) => {
				acc[value[0]] = value[1];
				return acc;
			}, {});
			await fs.writeJSON(`./cache/${category}/output.json`, output);

			store.set(category, categoryData);
		}

		return store;
	} catch (error) {
		console.error(error);
	}
}

/**
 * Exclude some spells by name
 */
const blacklist = new Set([
	'Drink',
	'Food',
	'Food & Drink',
	'Brain Food',
	'Refreshment',
	'Refreshing Drink',
	'Refreshing Food',
	'Bountiful Drink',
	'Bountiful Food',
	'Holiday Drink',
	'Brewfest Drink',
]);

/**
 * Get all auras associated with an item by following its effects.
 * @param {number}   spellID    - spell id referenced by the item
 * @param {Object[]} spells     - the spells for the given item category
 * @param {Object}   [auras={}] - related auras as `id - name` pairs
 * @param {Set}      [lookedup] - a set of looked up spells to guard against circular references
 * @return {Object} the related spells
 */
function getAurasForItem(spellID, spells, auras = {}, lookedup = new Set()) {
	// guard against circular references
	if (lookedup.has(spellID)) return;

	const spellData = getData(spellID, spells);
	// TODO: throw or return here
	if (!spellData) console.error(`No spell data for ${spellID}`);
	lookedup.add(spellID);

	for (const effect of spellData.Effects) {
		// TODO: some general rule for exceptions
		if (effect.Aura && !blacklist.has(spellData.Name)) {
			auras[spellID] = spellData.Name;
		}
		if (effect.AffectedSpell) {
			getAurasForItem(effect.AffectedSpell, spells, auras, lookedup);
		}
	}

	return auras;
}

/**
 * Query full spell or item information.
 * Sequential search without any optimization. The store is sorted by id though ...
 * @param {number}   id       - spell or item id
 * @param {Object[]} store    - db of spells/items for a given category
 * @return {Object|undefined} - the spell or item data or undefined if the id is not found in the store
 */
function getData(id, store) {
	for (const data of store) {
		if (data.ID === id) {
			return data;
		}
	}
}

/**
 * Creates a store array of spells/items objects from a saved json file.
 * @param {string} file - relative path to the json file
 * @return {Object[]}   - am array of de-serialized objects or an empty array
 */
async function loadCache(file) {
	try {
		const loaded = await fs.readFile(file, 'utf-8');
		console.log(`Reusing cache ${file}`);
		return JSON.parse(loaded);
	} catch (error) {
		return [];
	}
}

/**
 * Updates/Creates the items cache for a given catefory
 * @param {string} category
 * @return {Object} cache
 * @return {Object[]} cache.items
 * @return {Set} cache.cache
 */
async function updateItemsCache(category) {
	const path = `./cache/${category}`;
	const items = await loadCache(`${path}/items.json`);

	const cache = new Set();
	for (const item of items) {
		cache.add(item.ID);
	}
	const numFound = cache.size;

	let info = await fs.readFile(`${path}/${category}.json`, 'utf-8');
	info = JSON.parse(info).itemIDs;

	// check if info has uncached items and load them
	for (const itemID of info) {
		if (!cache.has(itemID)) {
			try {
				let item = await downloadJson('item', itemID);
				items.push(item);
				cache.add(itemID);
			} catch (error) {
				console.log(`Failed fetching item ${itemID}: ${error.message}`);
			}
		}
	}

	if (cache.size !== numFound) {
		console.log(`${cache.size - numFound} new items found.`);
		// sort and write back to disk
		items.sort((a, b) => a.ID - b.ID);
		await fs.writeJSON(`${path}/items.json`, items);
	}

	return { items, cache };
}

async function updateSpellsCache(category, items) {
	const path = `./cache/${category}`;
	const spells = await loadCache(`${path}/spells.json`);

	const cache = new Set();
	for (const spell of spells) {
		cache.add(spell.ID);
	}
	const numFound = cache.size;

	for (const item of items) {
		for (let spell of item.Spells) {
			await cacheRelatedSpells(spell.SpellID, spells, cache);
		}
	}

	if (cache.size !== numFound) {
		console.log(`${cache.size - numFound} new spells found.`);
		// sort and write back to disk
		spells.sort((a, b) => a.ID - b.ID);
		await fs.writeJSON(`${path}/spells.json`, spells);
	}

	return { spells, cache };
}

async function cacheRelatedSpells(spellID, spells, cache) {
	if (cache.has(spellID)) return;

	try {
		const spell = await downloadJson('spell', spellID);
		spells.push(spell);
		cache.add(spellID);

		for (const effect of spell.Effects) {
			if (effect.AffectedSpell) {
				await cacheRelatedSpells(effect.AffectedSpell, spells, cache);
			}
		}
	} catch (error) {
		console.log(`Failed fetching spell ${spellID}: ${error.message}`);
	}
}

async function downloadJson(type, id) {
	console.log(`Fetching data for ${type} ${id} ...`);
	let data = await wowdb.get(`/${type}/${id}`);
	// wowdb encases JSON in parens, so strip them away
	data = data.data.substring(1, data.data.length - 1);

	return JSON.parse(data);
}

(async function getMeDataz() {
	await prepareCategories();
	await prepareCategoryLists();
	await prepareItemAndSpellData();
})();
