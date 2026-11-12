/**
 * Headless harness for dsh-session-unread-toggle 1.1.0: mocks the Client
 * services the browser half reads, then drives the scenarios the release adds.
 */
const fs = require('node:fs');
const assert = require('node:assert');

const CLIENT = process.argv[2];
const STORAGE_KEY = 'dsh.sessionUnreadMarks.v1';

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

function boot({ marks = [], rows = [], archived = [], phase = 'ready' } = {}) {
	const storage = createStorage();
	if (marks.length > 0) storage.setItem(STORAGE_KEY, JSON.stringify(marks));

	const sessionsList = createStore(listOfSessions(rows, phase));
	const workspacesList = createStore({ items: [], archivedSessionIds: archived });
	const completionUnread = new Set();
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
					pendingInteraction: undefined,
					completionUnread: completionUnread.has(id),
				});
			}
			status.set(next);
		},
	};

	const effects = [];
	const menus = [];
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
		locale: { bind: () => (key) => key, register: () => ({}) },
		slots: { inject: () => {}, register: () => ({}) },
		contextMenus: {
			register: (definition) => {
				menus.push(definition);
				return () => {};
			},
		},
	};

	global.window = window;
	global.document = { querySelector: () => null };
	eval(fs.readFileSync(CLIENT, 'utf8'));
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
		status,
		window,
		windowListeners,
		menus,
		get published() {
			return publishCount;
		},
		/** Simulate another tab writing marks. */
		otherTabWrites(value) {
			storage.setItem(STORAGE_KEY, value);
			windowListeners.get('storage')?.({ key: STORAGE_KEY });
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

const width = Math.max(...results.map(([state, name]) => name.length));
for (const [state, name, detail] of results) {
	console.log(`${state}  ${name.padEnd(width)}  ${detail}`);
}
const failed = results.filter(([state]) => state === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
