window.__ModuleLoader__.load({
	id: 'dsh-session-unread-toggle',
	factory(require) {
		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		const NS = 'sessionUnreadToggle';

		/** Browser-local marks survive a reload, unlike the process-local reminder set. */
		const STORAGE_KEY = 'dsh.sessionUnreadMarks.v1';

		const DICTIONARIES = {
			en: {
				'mark.unread': 'Mark as unread',
				'mark.read': 'Mark as read',
			},
			ru: {
				'mark.unread': 'Отметить как непрочитанное',
				'mark.read': 'Отметить как прочитанное',
			},
			zh: {
				'mark.unread': '标记为未读',
				'mark.read': '标记为已读',
			},
		};

		/**
		 * Read the persisted marks.
		 * @returns map of Session id to whether the reader has already left that Session since marking it.
		 */
		function readMarks() {
			const marks = new Map();
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return marks;
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return marks;
				for (const entry of parsed) {
					if (typeof entry === 'string') marks.set(entry, true);
					else if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
						marks.set(entry.id, entry.armed === true);
					}
				}
			} catch (_error) {
				// A corrupt or unavailable storage drops the marks instead of failing the page.
			}
			return marks;
		}

		/**
		 * Persist the marks.
		 * @param marks - current mark map.
		 */
		function writeMarks(marks) {
			try {
				const rows = [];
				for (const [id, armed] of marks) rows.push({ id, armed });
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
			} catch (_error) {
				// Storage quota or a private window keeps the marks for this page only.
			}
		}

		/**
		 * Mark set plus the observable face the context menu re-resolves from.
		 * @returns the store used by this plugin.
		 */
		function createMarkStore() {
			const marks = readMarks();
			let snapshot = new Set(marks.keys());
			const listeners = new Set();
			const publish = () => {
				snapshot = new Set(marks.keys());
				writeMarks(marks);
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (_error) {
						// One broken subscriber must not stop the others.
					}
				}
			};
			return {
				source: {
					getSnapshot: () => snapshot,
					subscribe(listener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
				},
				has: (sessionId) => snapshot.has(sessionId),
				entries: () => [...marks],
				mark(sessionId, armed) {
					if (marks.get(sessionId) === armed) return;
					marks.set(sessionId, armed);
					publish();
				},
				clear(sessionId) {
					if (!marks.delete(sessionId)) return;
					publish();
				},
			};
		}

		/** The green completion dot, exactly as a Session row draws it. */
		function UnreadDotIcon() {
			return React.createElement(primitives.StateDot, { state: 'done', size: 10 });
		}

		/** A read mark: the same circle without the completion color. */
		function ReadIcon() {
			return React.createElement(primitives.IconCheckCircleOutline, { size: 14 });
		}

		return {
			inject: ['slots', 'locale', 'contextMenus', 'sessions', 'workspaces', 'uiSession'],
			apply(ctx) {
				const sessions = ctx.get('sessions');
				const workspaces = ctx.get('workspaces');
				const t = ctx.locale.bind(NS);
				const marks = createMarkStore();

				/** The Client Session service that owns the process-local completion reminders. */
				const sessionService = () => {
					const direct = ctx.get('uiSession');
					if (direct !== undefined) return direct;
					try {
						return ctx.root.get('uiSession');
					} catch (_error) {
						return undefined;
					}
				};

				const listOf = () => sessions.list.getSnapshot();
				const isMain = (row) => (row?.retainedBy?.mainView ?? 0) > 0;
				const isArchived = (sessionId) =>
					workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId);
				/** Whether the Session ever ran a prompt, so "finished" means something. */
				const hasPrompt = (row) => row?.projectionValues?.sessionListMetadata?.lastPromptAt != null;

				/**
				 * Mirror the marks onto the Session service's own completion reminders.
				 * A mark keeps its dot until the reader opens that Session again; the
				 * Session they are looking at right now stays read, and its dot appears
				 * once they leave it.
				 */
				const sync = () => {
					const uiSession = sessionService();
					const unread = uiSession?.completionUnread;
					if (!(unread instanceof Set)) return;
					const list = listOf();
					let changed = false;
					for (const [sessionId, armed] of marks.entries()) {
						const row = list.byId[sessionId];
						if (row === undefined) {
							if (list.phase === 'ready') marks.clear(sessionId);
							continue;
						}
						if (isArchived(sessionId)) {
							// An archived row draws no status dot; drop the mark with it.
							marks.clear(sessionId);
							if (unread.delete(sessionId)) changed = true;
							continue;
						}
						const main = isMain(row);
						if (main && armed) {
							// The reader came back: the reminder is served.
							marks.clear(sessionId);
							if (unread.delete(sessionId)) changed = true;
							continue;
						}
						if (!main && !armed) marks.mark(sessionId, true);
						if (main) {
							if (unread.delete(sessionId)) changed = true;
							continue;
						}
						if (row.running === true) continue;
						if (!unread.has(sessionId)) {
							unread.add(sessionId);
							changed = true;
						}
					}
					if (changed && typeof uiSession.publishStatus === 'function') uiSession.publishStatus();
				};

				/** Turn the reminder on or off for one Session. */
				const setUnread = (sessionId, want) => {
					const uiSession = sessionService();
					const unread = uiSession?.completionUnread;
					if (want) {
						const row = listOf().byId[sessionId];
						marks.mark(sessionId, !isMain(row));
					} else {
						marks.clear(sessionId);
						if (unread instanceof Set && unread.delete(sessionId) && typeof uiSession.publishStatus === 'function') {
							uiSession.publishStatus();
						}
					}
					sync();
				};

				ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-unread: dictionaries');

				ctx.effect(
					() => {
						const dispose = sessions.list.subscribe(() => {
							sync();
						});
						sync();
						return dispose;
					},
					'session-unread: reminder sync',
				);

				const menuDefinition = {
					id: 'session.unread',
					target: 'session',
					order: 350,
					observe: () => [marks.source, sessions.list, workspaces.list],
					resolve: (target) => {
						const sessionId = target.sessionId;
						const row = listOf().byId[sessionId];
						if (row === undefined || row.blank === true || row.origin === 'subagent') return [];
						if (row.running === true || !hasPrompt(row)) return [];
						if (isArchived(sessionId)) return [];
						const unread = marks.has(sessionId);
						return [
							{
								id: 'toggle',
								label: t(unread ? 'mark.read' : 'mark.unread'),
								icon: { key: unread ? 'session.unread.read' : 'session.unread.unread' },
								run: () => setUnread(sessionId, !unread),
							},
						];
					},
				};

				ctx.effect(
					() => ctx.contextMenus.register(menuDefinition),
					'session-unread: context menu',
				);

				ctx.slots.inject('contextMenu.icon', function* () {
					yield ctx.slots.register(
						{ name: 'contextMenu.icon', key: 'session.unread.unread' },
						UnreadDotIcon,
					);
					yield ctx.slots.register(
						{ name: 'contextMenu.icon', key: 'session.unread.read' },
						ReadIcon,
					);
				});
			},
		};
	},
});