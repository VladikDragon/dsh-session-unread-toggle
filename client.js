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
		 * Whether two mark maps say the same thing.
		 * @param left - first map.
		 * @param right - second map.
		 * @returns whether both hold the same ids with the same armed flags.
		 */
		function sameMarks(left, right) {
			if (left.size !== right.size) return false;
			for (const [id, armed] of left) {
				if (right.get(id) !== armed) return false;
			}
			return true;
		}

		/**
		 * Mark set plus the observable face the context menu re-resolves from.
		 * @returns the store used by this plugin.
		 */
		function createMarkStore() {
			let marks = readMarks();
			let snapshot = new Set(marks.keys());
			const listeners = new Set();
			const notify = () => {
				snapshot = new Set(marks.keys());
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (_error) {
						// One broken subscriber must not stop the others.
					}
				}
			};
			const publish = () => {
				notify();
				writeMarks(marks);
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
				/**
				 * Adopt the marks another tab or window wrote. The reload is not
				 * written back, so two tabs cannot echo the same value at each other.
				 * @returns whether anything changed.
				 */
				reload() {
					const next = readMarks();
					if (sameMarks(marks, next)) return false;
					marks = next;
					notify();
					return true;
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
				 * Reminders this plugin put into `completionUnread`. They are withdrawn
				 * when their mark goes away, including a mark cleared in another tab,
				 * while a dot the Session service raised on its own is left alone.
				 */
				const owned = new Set();

				/**
				 * Mirror the marks onto the Session service's own completion reminders.
				 * A mark keeps its dot until the reader opens that Session again; the
				 * Session they are looking at right now stays read, and its dot appears
				 * once they leave it. An archived Session keeps its mark but draws no
				 * dot, so the mark is waiting when the Session is restored.
				 */
				let syncing = false;
				const sync = () => {
					// Publishing the status re-enters this function through its own
					// subscription; the pass in flight has already read every mark.
					if (syncing) return;
					const uiSession = sessionService();
					const unread = uiSession?.completionUnread;
					if (!(unread instanceof Set)) return;
					syncing = true;
					try {
						const list = listOf();
						let changed = false;
						for (const [sessionId, armed] of marks.entries()) {
							const row = list.byId[sessionId];
							if (row === undefined) {
								if (list.phase === 'ready') marks.clear(sessionId);
								continue;
							}
							if (isArchived(sessionId)) {
								// An archived row draws no status dot: hold the mark, drop only the reminder.
								owned.delete(sessionId);
								if (unread.delete(sessionId)) changed = true;
								continue;
							}
							const main = isMain(row);
							if (main && armed) {
								// The reader came back: the reminder is served.
								marks.clear(sessionId);
								owned.delete(sessionId);
								if (unread.delete(sessionId)) changed = true;
								continue;
							}
							if (!main && !armed) marks.mark(sessionId, true);
							if (main) {
								owned.delete(sessionId);
								if (unread.delete(sessionId)) changed = true;
								continue;
							}
							if (row.running === true) continue;
							if (!unread.has(sessionId)) {
								unread.add(sessionId);
								changed = true;
							}
							owned.add(sessionId);
						}
						// A mark that is gone, wherever it was cleared, takes its dot with it.
						for (const sessionId of [...owned]) {
							if (marks.has(sessionId)) continue;
							owned.delete(sessionId);
							if (unread.delete(sessionId)) changed = true;
						}
						if (changed && typeof uiSession.publishStatus === 'function') uiSession.publishStatus();
					} finally {
						syncing = false;
					}
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
						owned.delete(sessionId);
						if (unread instanceof Set && unread.delete(sessionId) && typeof uiSession.publishStatus === 'function') {
							uiSession.publishStatus();
						}
					}
					sync();
				};

				ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-unread: dictionaries');

				ctx.effect(
					() => {
						let statusDispose;
						/**
						 * Follow the status store as well, so a dot returns after a reload
						 * and after a running Session finishes, not only when the list
						 * itself changes. The service is looked up again on every list
						 * change in case it was not reachable yet.
						 */
						const bindStatus = () => {
							if (statusDispose !== undefined) return;
							const status = sessionService()?.sessionStatus;
							if (status?.subscribe === undefined) return;
							statusDispose = status.subscribe(sync);
						};
						const disposers = [
							sessions.list.subscribe(() => {
								bindStatus();
								sync();
							}),
							workspaces.list.subscribe(sync),
						];
						bindStatus();
						sync();
						return () => {
							for (const dispose of disposers) dispose();
							if (statusDispose !== undefined) statusDispose();
						};
					},
					'session-unread: reminder sync',
				);

				ctx.effect(
					() => {
						/** Another tab marked a Session, so this one adopts the marks and redraws. */
						const onStorage = (event) => {
							if (event.key !== null && event.key !== STORAGE_KEY) return;
							if (marks.reload()) sync();
						};
						window.addEventListener('storage', onStorage);
						return () => window.removeEventListener('storage', onStorage);
					},
					'session-unread: cross-window marks',
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
