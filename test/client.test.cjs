/**
 * Headless harness for dsh-session-unread-toggle: mocks the Client services and the
 * little DOM the browser half touches, then drives the release's scenarios.
 *
 * Run: node test/client.test.cjs client.js
 */
const fs = require('node:fs');
const assert = require('node:assert');

const CLIENT = process.argv[2] ?? 'client.js';
const STORAGE_KEY = 'dsh.sessionUnreadMarks.v1';
const FOLDER_SLOT = 'sidebar.workspace.row.trailing';

// ------------------------------------------------------------------ fake DOM

class FakeElement {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.attributes = new Map();
		this.childNodes = [];
		this.parentNode = null;
		this.textContent = '';
		this._classes = '';
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	get class() {
		return this._classes;
	}
	set class(value) {
		this._classes = String(value);
	}
	get lastElementChild() {
		return this.childNodes.length === 0 ? null : this.childNodes[this.childNodes.length - 1];
	}
	appendChild(child) {
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}
	insertBefore(child, anchor) {
		const index = this.childNodes.indexOf(anchor);
		child.parentNode = this;
		if (index < 0) this.childNodes.push(child);
		else this.childNodes.splice(index, 0, child);
		return child;
	}
	remove() {
		if (this.parentNode === null) return;
		const index = this.parentNode.childNodes.indexOf(this);
		if (index >= 0) this.parentNode.childNodes.splice(index, 1);
		this.parentNode = null;
	}
	querySelectorAll(selector) {
		const out = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (matchSelector(child, selector)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

/** Supports only the selector shapes this plugin uses. */
function matchSelector(element, selector) {
	if (selector.startsWith('[data-row-key^="')) {
		const prefix = selector.slice('[data-row-key^="'.length, -2);
		const value = element.getAttribute('data-row-key');
		return value !== null && value.startsWith(prefix);
	}
	if (selector.startsWith('[class*="')) {
		const needle = selector.slice('[class*="'.length, -2);
		return element.class.includes(needle);
	}
	if (selector.startsWith('[') && selector.endsWith(']')) {
		const body = selector.slice(1, -1);
		const equals = body.indexOf('=');
		if (equals < 0) return element.getAttribute(body) !== null;
		const name = body.slice(0, equals);
		const value = body.slice(equals + 1).replace(/^"|"$/g, '');
		return element.getAttribute(name) === value;
	}
	throw new Error('unsupported selector: ' + selector);
}

/** One folder row shaped like the sidebar's: title, then the hover actions. */
function makeFolderRow(key) {
	const row = new FakeElement('div');
	row.setAttribute('data-row-key', 'workspace:' + key);
	row.setAttribute('aria-expanded', 'false');
	const title = new FakeElement('span');
	title.class = 'wnFoaW_title';
	title.textContent = key === '' ? 'Ungrouped' : key;
	row.appendChild(title);
	const actions = new FakeElement('span');
	actions.class = 'wnFoaW_rowActions';
	row.appendChild(actions);
	return row;
}

function installDom() {
	const head = new FakeElement('head');
	const body = new FakeElement('body');
	const document = {
		head,
		body,
		createElement: (tag) => new FakeElement(tag),
		querySelectorAll: (selector) => body.querySelectorAll(selector),
		querySelector: (selector) => body.querySelector(selector),
	};
	let frames = [];
	global.document = document;
	global.requestAnimationFrame = (callback) => {
		frames.push(callback);
		return frames.length;
	};
	global.MutationObserver = class {
		constructor(callback) {
			this.callback = callback;
		}
		observe() {}
		disconnect() {}
	};
	return {
		document,
		head,
		body,
		flush() {
			const queued = frames;
			frames = [];
			for (const callback of queued) callback();
		},
		reset() {
			body.childNodes = [];
			head.childNodes = [];
			frames = [];
		},
	};
}

const dom = installDom();

/** Minimal localStorage with a shared backing store, so "another tab" is the same map. */
function createStorage() {
	const data = new Map();
	return {
		data,
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
		removeItem: (key) => data.delete(key),
	};
}

/** One store shaped like the Client's snapshot stores. */
function createStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			snapshot = next;
			for (const listener of [...listeners]) listener();
		},
		listeners,
	};
}

function makeSession(id, overrides = {}) {
	return {
		id,
		running: false,
		blank: false,
		origin: 'user',
		retainedBy: { mainView: 0 },
		projectionValues: { sessionListMetadata: { lastPromptAt: '2026-11-11T00:00:00Z' } },
		...overrides,
	};
}

function listOfSessions(rows, phase = 'ready') {
	const byId = {};
	const ids = [];
	for (const row of rows) {
		byId[row.id] = row;
		ids.push(row.id);
	}
	return { phase, ids, byId };
}

/**
 * Boot the plugin against the mocked services.
 * @param options.folderSlot - whether the patched Workspace browser declares the folder seat.
 */
function boot({
	marks = [],
	rows = [],
	archived = [],
	phase = 'ready',
	workspaces = [],
	folders = [],
	folderSlot = false,
} = {}) {
	dom.reset();
	const storage = createStorage();
	if (marks.length > 0) storage.setItem(STORAGE_KEY, JSON.stringify(marks));

	const sessionsList = createStore(listOfSessions(rows, phase));
	const workspacesList = createStore({ items: workspaces, archivedSessionIds: archived });
	const completionUnread = new Set();
	const pending = new Map();
	let publishCount = 0;
	const status = createStore(new Map());

	const uiSession = {
		completionUnread,
		sessionStatus: status,
		publishStatus() {
			publishCount += 1;
			const next = new Map();
			for (const id of sessionsList.getSnapshot().ids) {
				next.set(id, {
					running: sessionsList.getSnapshot().byId[id].running,
					pendingInteraction: pending.get(id),
					completionUnread: completionUnread.has(id),
				});
			}
			status.set(next);
		},
	};

	const folderRows = new Map();
	for (const key of folders) {
		const row = makeFolderRow(key);
		dom.body.appendChild(row);
		folderRows.set(key, row);
	}

	const effects = [];
	const menus = [];
	const slotRegistrations = [];
	const windowListeners = new Map();
	const window = {
		localStorage: storage,
		addEventListener: (type, handler) => windowListeners.set(type, handler),
		removeEventListener: (type) => windowListeners.delete(type),
	};
	const loaded = [];
	window.__ModuleLoader__ = { load: (mod) => loaded.push(mod) };

	const ctx = {
		get: (name) => ({ sessions: { list: sessionsList }, workspaces: { list: workspacesList }, uiSession })[name],
		root: { get: () => undefined },
		effect: (fn) => {
			const dispose = fn();
			effects.push(dispose);
			return dispose;
		},
		locale: {
			bind: () => (key, params) => (params === undefined ? key : key + ':' + JSON.stringify(params)),
			register: () => ({}) ,
		},
		slots: {
			// A declaration the patched browser never makes simply never fires, which is
			// exactly how a stock DSH behaves.
			inject: (key, callback) => {
				if (key !== FOLDER_SLOT || !folderSlot) return () => {};
				const dispose = callback();
				return dispose;
			},
			register: (options, component) => {
				slotRegistrations.push({ options, component });
				return () => {};
			},
		},
		contextMenus: {
			register: (definition) => {
				menus.push(definition);
				return () => {};
			},
		},
	};

	global.window = window;
	loaded.length = 0;
	new Function('window', 'document', 'requestAnimationFrame', 'MutationObserver', fs.readFileSync(CLIENT, 'utf8'))(
		window,
		global.document,
		global.requestAnimationFrame,
		global.MutationObserver,
	);
	const mod = loaded[0];
	const plugin = mod.factory(() => ({
		createElement: () => ({}),
		StateDot: () => ({}),
		IconCheckCircleOutline: () => ({}),
	}));
	plugin.apply(ctx);

	return {
		storage,
		sessionsList,
		workspacesList,
		completionUnread,
		pending,
		status,
		window,
		windowListeners,
		menus,
		slotRegistrations,
		folderRows,
		body: dom.body,
		get published() {
			return publishCount;
		},
		/** Raise or clear the pending interaction of one Session, as the service would. */
		setPending(sessionId, interaction = { kind: 'approval' }) {
			if (interaction === null) pending.delete(sessionId);
			else pending.set(sessionId, interaction);
			uiSession.publishStatus();
		},
		/** Simulate another tab writing marks. */
		otherTabWrites(value) {
			storage.setItem(STORAGE_KEY, value);
			windowListeners.get('storage')?.({ key: STORAGE_KEY });
		},
		/** Let the coalesced repaint run. */
		paint() {
			dom.flush();
		},
		/** The mark drawn on a folder row, if any. */
		badge(key) {
			return folderRows.get(key)?.querySelector('[data-unread-folder-badge]') ?? null;
		},
		/** The count one segment of a folder mark shows, or null while it is hidden. */
		badgeCount(key, kind = 'unread') {
			const badge = this.badge(key);
			if (badge === null) return null;
			const segment = badge.querySelector('[data-kind="' + kind + '"]');
			if (segment === null || segment.getAttribute('hidden') !== null) return null;
			return segment.lastElementChild.textContent;
		},
		dispose() {
			for (const dispose of effects.reverse()) {
				if (typeof dispose === 'function') dispose();
			}
		},
	};
}

const results = [];
function check(name, fn) {
	try {
		fn();
		results.push(['PASS', name, '']);
	} catch (error) {
		results.push(['FAIL', name, error.message]);
	}
}

const A = 'ws-a';
const B = 'ws-b';
const folder = (workspaceId, sessionIds) => ({ workspaceId, path: 'C:\\' + workspaceId, title: workspaceId, sessionIds, createdAt: '2026-11-01T00:00:00Z' });

// 1. A persisted mark restores the dot on the first pass after a reload.
check('restores a persisted mark after reload', () => {
	const app = boot({
		marks: [{ id: 's1', armed: true }],
		rows: [makeSession('s1'), makeSession('s2')],
	});
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 2. A mark made while the Session was open is armed on the first pass after reload.
check('arms a mark that was made while the Session was open', () => {
	const app = boot({ marks: [{ id: 's1', armed: false }], rows: [makeSession('s1')] });
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	assert.deepStrictEqual(JSON.parse(app.storage.getItem(STORAGE_KEY)), [{ id: 's1', armed: true }]);
	app.dispose();
});

// 3. Archiving keeps the mark and drops only the dot; restoring brings it back.
check('keeps the mark through archiving and restores the dot', () => {
	const app = boot({ marks: [{ id: 's1', armed: true }], rows: [makeSession('s1')] });
	assert.deepStrictEqual([...app.completionUnread], ['s1']);

	app.workspacesList.set({ items: [], archivedSessionIds: ['s1'] });
	assert.deepStrictEqual([...app.completionUnread], []);
	assert.deepStrictEqual(JSON.parse(app.storage.getItem(STORAGE_KEY)), [{ id: 's1', armed: true }]);

	app.workspacesList.set({ items: [], archivedSessionIds: [] });
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 4. A mark on a running Session waits for it to finish.
check('waits for a running Session before drawing the dot', () => {
	const app = boot({ marks: [{ id: 's1', armed: true }], rows: [makeSession('s1', { running: true })] });
	assert.deepStrictEqual([...app.completionUnread], []);

	app.sessionsList.set(listOfSessions([makeSession('s1', { running: false })]));
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 5. The status store alone re-runs the sync, without any list change.
check('re-syncs from the status store', () => {
	const app = boot({ marks: [{ id: 's1', armed: true }], rows: [makeSession('s1')] });
	app.completionUnread.clear();
	app.status.set(new Map([['s1', { running: false, completionUnread: false }]]));
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 6. Another tab's mark is adopted, and a cleared mark disappears.
check('adopts marks written by another tab', () => {
	const app = boot({ rows: [makeSession('s1'), makeSession('s2')] });
	assert.deepStrictEqual([...app.completionUnread], []);

	app.otherTabWrites(JSON.stringify([{ id: 's2', armed: true }]));
	assert.deepStrictEqual([...app.completionUnread], ['s2']);

	app.otherTabWrites(JSON.stringify([]));
	assert.deepStrictEqual([...app.completionUnread], []);
	app.dispose();
});

// 7. A mark on a Session deleted from the list is dropped once the list is ready.
check('drops a mark whose Session is gone', () => {
	const app = boot({ marks: [{ id: 'gone', armed: true }], rows: [makeSession('s1')] });
	assert.strictEqual(app.storage.getItem(STORAGE_KEY), '[]');
	app.dispose();
});

// 8. Marks are held while the list is still loading.
check('holds marks while the list is pending', () => {
	const app = boot({ marks: [{ id: 's1', armed: true }], rows: [], phase: 'pending' });
	assert.deepStrictEqual(JSON.parse(app.storage.getItem(STORAGE_KEY)), [{ id: 's1', armed: true }]);

	app.sessionsList.set(listOfSessions([makeSession('s1')]));
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 9. The context menu offers the right action and hides where it should.
check('offers the toggle only where it applies', () => {
	const app = boot({ marks: [{ id: 's1', armed: true }], rows: [makeSession('s1'), makeSession('s2')] });
	const menu = app.menus.find((definition) => definition.id === 'session.unread');
	assert.ok(menu, 'menu registered');
	assert.strictEqual(menu.target, 'session');

	const read = menu.resolve({ sessionId: 's1' });
	assert.strictEqual(read[0].label, 'mark.read');
	const unread = menu.resolve({ sessionId: 's2' });
	assert.strictEqual(unread[0].label, 'mark.unread');

	read[0].run();
	assert.deepStrictEqual([...app.completionUnread], []);
	assert.strictEqual(app.storage.getItem(STORAGE_KEY), '[]');

	unread[0].run();
	assert.deepStrictEqual([...app.completionUnread], ['s2']);

	assert.deepStrictEqual(menu.resolve({ sessionId: 'missing' }), []);
	app.dispose();
});

// 10. A dot the Session service raised on its own is left alone.
check('leaves a dot the Session service raised alone', () => {
	const app = boot({ rows: [makeSession('s1'), makeSession('s2')] });
	app.completionUnread.add('s1');
	app.sessionsList.set(listOfSessions([makeSession('s1'), makeSession('s2')]));
	assert.deepStrictEqual([...app.completionUnread], ['s1']);
	app.dispose();
});

// 11. Teardown removes the window listener and every store subscription.
check('disposes cleanly', () => {
	const app = boot({ rows: [makeSession('s1')] });
	app.dispose();
	assert.strictEqual(app.windowListeners.size, 0);
	assert.strictEqual(app.sessionsList.listeners.size, 0);
	assert.strictEqual(app.workspacesList.listeners.size, 0);
	assert.strictEqual(app.status.listeners.size, 0);
});

// ------------------------------------------------------------- folder marks

// 12. The fallback decorates a folder row with the dot and the count.
check('fallback draws the folder mark', () => {
	const app = boot({
		rows: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
		workspaces: [folder(A, ['s1', 's2']), folder(B, ['s3'])],
		folders: [A, B],
	});
	app.completionUnread.add('s1');
	app.completionUnread.add('s2');
	app.completionUnread.add('s3');
	app.sessionsList.set(listOfSessions([makeSession('s1'), makeSession('s2'), makeSession('s3')]));
	app.paint();

	assert.strictEqual(app.badgeCount(A), '2');
	assert.strictEqual(app.badgeCount(B), '1');
	const badge = app.badge(A);
	assert.strictEqual(badge.getAttribute('role'), 'img');
	assert.ok(badge.getAttribute('aria-label').startsWith('folders.unread'));
	const row = app.folderRows.get(A);
	assert.strictEqual(row.childNodes.indexOf(badge), row.childNodes.length - 2, 'mark sits before the actions');
	app.dispose();
});

// 13. Archived, running, blank and subagent Sessions never reach a folder count.
check('fallback skips Sessions that draw no dot', () => {
	const app = boot({
		rows: [
			makeSession('arch'),
			makeSession('run', { running: true }),
			makeSession('blank', { blank: true }),
			makeSession('sub', { origin: 'subagent' }),
		],
		archived: ['arch'],
		workspaces: [folder(A, ['arch', 'run', 'blank', 'sub'])],
		folders: [A],
	});
	for (const id of ['arch', 'run', 'blank', 'sub']) app.completionUnread.add(id);
	app.sessionsList.set(listOfSessions(app.sessionsList.getSnapshot().ids.map((id) => app.sessionsList.getSnapshot().byId[id])));
	app.paint();

	assert.strictEqual(app.badge(A), null);
	app.dispose();
});

// 14. A Session outside every folder is counted on the ungrouped row.
check('fallback counts strays on the ungrouped row', () => {
	const app = boot({
		rows: [makeSession('s1'), makeSession('stray')],
		workspaces: [folder(A, ['s1'])],
		folders: [A, ''],
	});
	app.completionUnread.add('stray');
	app.sessionsList.set(listOfSessions([makeSession('s1'), makeSession('stray')]));
	app.paint();

	assert.strictEqual(app.badgeCount(''), '1');
	assert.strictEqual(app.badge(A), null);
	app.dispose();
});

// 15. Clearing the reminder removes the mark, and a repaint never duplicates it.
check('fallback clears and never duplicates', () => {
	const app = boot({ rows: [makeSession('s1')], workspaces: [folder(A, ['s1'])], folders: [A] });
	app.completionUnread.add('s1');
	app.sessionsList.set(listOfSessions([makeSession('s1')]));
	app.paint();
	assert.strictEqual(app.badgeCount(A), '1');

	app.paint();
	assert.strictEqual(app.folderRows.get(A).querySelectorAll('[data-unread-folder-badge]').length, 1);

	app.completionUnread.delete('s1');
	app.sessionsList.set(listOfSessions([makeSession('s1')]));
	app.paint();
	assert.strictEqual(app.badge(A), null);
	app.dispose();
});

// 16. With the patched browser the plugin registers the seat and draws nothing itself.
check('slot mode registers the seat and leaves the DOM alone', () => {
	const app = boot({
		rows: [makeSession('s1')],
		workspaces: [folder(A, ['s1'])],
		folders: [A],
		folderSlot: true,
	});
	app.completionUnread.add('s1');
	app.sessionsList.set(listOfSessions([makeSession('s1')]));
	app.paint();

	const seat = app.slotRegistrations.find((entry) => entry.options.name === FOLDER_SLOT);
	assert.ok(seat, 'folder seat registered');
	assert.strictEqual(seat.options.id, 'unread-folder-mark');
	assert.strictEqual(seat.options.locale, 'sessionUnreadToggle');
	assert.strictEqual(typeof seat.component, 'function');
	assert.strictEqual(app.badge(A), null, 'fallback stood down');
	app.dispose();
});

// 17. The dictionaries carry both folder labels in every shipped locale.
check('dictionaries carry the folder labels', () => {
	const source = fs.readFileSync(CLIENT, 'utf8');
	for (const key of ["'folders.unread'", "'folders.waiting'"]) {
		assert.ok(source.includes(key), 'missing ' + key);
	}
	const locales = source.match(/\b(en|ru|zh):\s*\{/g) ?? [];
	assert.strictEqual(locales.length, 3, 'three locales');
});

// 18. A folder whose Sessions wait for an answer shows the yellow dot and its count.
check('fallback draws the waiting mark', () => {
	const app = boot({
		rows: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
		workspaces: [folder(A, ['s1', 's2']), folder(B, ['s3'])],
		folders: [A, B],
	});
	app.setPending('s1');
	app.setPending('s2');
	app.paint();

	assert.strictEqual(app.badgeCount(A, 'waiting'), '2');
	assert.strictEqual(app.badgeCount(A, 'unread'), null, 'no green segment while nothing finished');
	assert.strictEqual(app.badge(B), null);
	const badge = app.badge(A);
	assert.strictEqual(badge.querySelectorAll('[data-kind]').length, 2, 'both segments exist');
	assert.ok(badge.getAttribute('aria-label').startsWith('folders.waiting'));
	app.dispose();
});

// 19. Waiting and unread are counted apart, each with its own number.
check('fallback counts waiting and unread separately', () => {
	const app = boot({
		rows: [makeSession('wait1'), makeSession('wait2'), makeSession('done1')],
		workspaces: [folder(A, ['wait1', 'wait2', 'done1'])],
		folders: [A],
	});
	app.completionUnread.add('done1');
	app.setPending('wait1');
	app.setPending('wait2');
	app.paint();

	assert.strictEqual(app.badgeCount(A, 'waiting'), '2');
	assert.strictEqual(app.badgeCount(A, 'unread'), '1');
	const label = app.badge(A).getAttribute('aria-label');
	assert.ok(label.includes('folders.waiting'), 'waiting label present');
	assert.ok(label.includes('folders.unread'), 'unread label present');
	assert.ok(label.includes(';'), 'labels joined');
	app.dispose();
});

// 20. An approval raised inside a subagent lands on the folder of the row above it, once.
check('fallback rolls a subagent approval up to its parent folder', () => {
	const app = boot({
		rows: [
			makeSession('parent'),
			makeSession('child', { origin: 'subagent', parentId: 'parent' }),
			makeSession('other'),
		],
		workspaces: [folder(A, ['parent']), folder(B, ['other'])],
		folders: [A, B],
	});
	app.setPending('child');
	app.paint();
	assert.strictEqual(app.badgeCount(A, 'waiting'), '1', 'counted on the parent folder');
	assert.strictEqual(app.badge(B), null);

	app.setPending('parent');
	app.paint();
	assert.strictEqual(app.badgeCount(A, 'waiting'), '1', 'parent and its child count once');

	app.setPending('child', null);
	app.setPending('parent', null);
	app.paint();
	assert.strictEqual(app.badge(A), null);
	app.dispose();
});

// 21. A waiting Session is counted even while it still runs, and archiving drops it.
check('fallback counts a running wait and skips archived ones', () => {
	const app = boot({
		rows: [makeSession('run', { running: true }), makeSession('arch')],
		archived: ['arch'],
		workspaces: [folder(A, ['run', 'arch'])],
		folders: [A],
	});
	app.setPending('run');
	app.setPending('arch');
	app.paint();

	assert.strictEqual(app.badgeCount(A, 'waiting'), '1', 'running wait counts, archived does not');
	app.dispose();
});

// 22. Answering the interaction clears only the yellow segment.
check('fallback clears the waiting segment alone', () => {
	const app = boot({
		rows: [makeSession('s1'), makeSession('s2')],
		workspaces: [folder(A, ['s1', 's2'])],
		folders: [A],
	});
	app.completionUnread.add('s2');
	app.setPending('s1');
	app.paint();
	assert.strictEqual(app.badgeCount(A, 'waiting'), '1');
	assert.strictEqual(app.badgeCount(A, 'unread'), '1');

	app.setPending('s1', null);
	app.paint();
	assert.strictEqual(app.badgeCount(A, 'waiting'), null, 'yellow segment hidden');
	assert.strictEqual(app.badgeCount(A, 'unread'), '1', 'green segment kept');
	assert.strictEqual(app.badge(A).querySelectorAll('[data-unread-folder-badge]').length, 0, 'no nested badge');
	app.dispose();
});

// 23. Repainting never duplicates the badge and keeps one pair per kind.
check('fallback keeps one badge with two segments', () => {
	const app = boot({ rows: [makeSession('s1')], workspaces: [folder(A, ['s1'])], folders: [A] });
	app.setPending('s1');
	app.paint();
	app.paint();
	app.paint();
	const badges = app.folderRows.get(A).querySelectorAll('[data-unread-folder-badge]');
	assert.strictEqual(badges.length, 1);
	assert.strictEqual(badges[0].querySelectorAll('[data-kind]').length, 2);
	app.dispose();
});

// 24. An interaction kind the row never draws lights no folder either.
check('fallback ignores an invisible interaction kind', () => {
	const app = boot({ rows: [makeSession('s1')], workspaces: [folder(A, ['s1'])], folders: [A] });
	app.setPending('s1', { kind: 'internal-housekeeping' });
	app.paint();
	assert.strictEqual(app.badge(A), null);
	app.dispose();
});

// 25. A waiting Session that still carries a reminder counts once, as waiting.
check('fallback counts a waiting Session only as waiting', () => {
	const app = boot({
		rows: [makeSession('s1')],
		workspaces: [folder(A, ['s1'])],
		folders: [A],
	});
	app.completionUnread.add('s1');
	app.setPending('s1');
	app.paint();

	assert.strictEqual(app.badgeCount(A, 'waiting'), '1');
	assert.strictEqual(app.badgeCount(A, 'unread'), null, 'the row draws one primary dot');
	app.dispose();
});

const width = Math.max(...results.map(([state, name]) => name.length));
for (const [state, name, detail] of results) {
	console.log(`${state}  ${name.padEnd(width)}  ${detail}`);
}
const failed = results.filter(([state]) => state === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
