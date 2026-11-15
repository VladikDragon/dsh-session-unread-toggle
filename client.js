window.__ModuleLoader__.load({
	id: 'dsh-session-unread-toggle',
	factory(require) {
		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		const NS = 'sessionUnreadToggle';

		/** Browser-local marks survive a reload, unlike the process-local reminder set. */
		const STORAGE_KEY = 'dsh.sessionUnreadMarks.v1';

		/** The folder-row seat this plugin prefers when the Workspace browser declares it. */
		const FOLDER_SLOT = 'sidebar.workspace.row.trailing';

		/** The row attribute the sidebar's folder row carries in every DSH build. */
		const ROW_ATTRIBUTE = 'data-row-key';
		const ROW_PREFIX = 'workspace:';
		const ROW_SELECTOR = '[' + ROW_ATTRIBUTE + '^="' + ROW_PREFIX + '"]';

		/** Marks this plugin drew itself, so a repaint finds them and a slot can replace them. */
		const BADGE_ATTRIBUTE = 'data-unread-folder-badge';
		const BADGE_SELECTOR = '[' + BADGE_ATTRIBUTE + ']';
		const STYLE_ATTRIBUTE = 'data-unread-folder-style';

		const DICTIONARIES = {
			en: {
				'mark.unread': 'Mark as unread',
				'mark.read': 'Mark as read',
				'folders.unread': 'Unread sessions: {n}',
			},
			ru: {
				'mark.unread': 'Отметить как непрочитанное',
				'mark.read': 'Отметить как прочитанное',
				'folders.unread': 'Непрочитанных сессий: {n}',
			},
			zh: {
				'mark.unread': '标记为未读',
				'mark.read': '标记为已读',
				'folders.unread': '未读会话：{n}',
			},
		};

		/** Folder marks borrow the row's geometry: a completion-sized dot and a count. */
		const STYLE = [
			BADGE_SELECTOR + ' {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 4px;',
			'  flex: none;',
			'  margin-left: 4px;',
			'  margin-right: 2px;',
			'  pointer-events: none;',
			'}',
			BADGE_SELECTOR + ' > i {',
			'  display: block;',
			'  width: 8px;',
			'  height: 8px;',
			'  border-radius: 50%;',
			'  flex: none;',
			'  background: var(--dsw-alias-state-success-primary, currentColor);',
			'}',
			BADGE_SELECTOR + ' > b {',
			'  font-size: 11px;',
			'  line-height: 16px;',
			'  font-weight: 500;',
			'  font-variant-numeric: tabular-nums;',
			'  color: var(--dsw-alias-label-secondary, currentColor);',
			'}',
		].join('\n');

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

				/**
				 * Unread Sessions per folder, counted from the very reminder set the
				 * sidebar draws dots from, so a folder never promises a dot that is
				 * absent inside it.
				 * @returns map of workspace id ('' for ungrouped) to unread count.
				 */
				const countUnread = () => {
					const counts = new Map();
					const unread = sessionService()?.completionUnread;
					if (!(unread instanceof Set) || unread.size === 0) return counts;
					const list = listOf();
					const snapshot = workspaces.list.getSnapshot();
					const archived = new Set(snapshot.archivedSessionIds ?? []);
					const rows = list.byId ?? {};

					/** Archived, running, blank and subagent Sessions draw no completion dot. */
					const countable = (sessionId) => {
						if (archived.has(sessionId)) return false;
						const row = rows[sessionId];
						if (row === undefined) return false;
						if (row.running === true) return false;
						if (row.blank === true) return false;
						if (row.origin === 'subagent') return false;
						return true;
					};

					const accounted = new Set();
					for (const workspace of snapshot.items ?? []) {
						let count = 0;
						for (const sessionId of workspace.sessionIds ?? []) {
							accounted.add(sessionId);
							if (unread.has(sessionId) && countable(sessionId)) count += 1;
						}
						if (count > 0) counts.set(workspace.workspaceId, count);
					}

					let stray = 0;
					for (const sessionId of list.ids ?? []) {
						if (accounted.has(sessionId)) continue;
						if (unread.has(sessionId) && countable(sessionId)) stray += 1;
					}
					if (stray > 0) counts.set('', stray);
					return counts;
				};

				/**
				 * Folder seat for the patched Workspace browser. It re-reads the counts
				 * whenever a Session, a folder or a status changes.
				 * @param props.workspaceId - the folder this row shows, undefined for the ungrouped row.
				 * @param props.t - this namespace's locale seat.
				 * @returns the mark, or nothing while the folder is clear.
				 */
				function FolderMark({ workspaceId, t: translate }) {
					const [, bump] = React.useState(0);
					React.useEffect(() => {
						const bumpOnce = () => bump((value) => value + 1);
						const disposers = [sessions.list.subscribe(bumpOnce), workspaces.list.subscribe(bumpOnce)];
						const status = sessionService()?.sessionStatus;
						if (status?.subscribe !== undefined) disposers.push(status.subscribe(bumpOnce));
						return () => {
							for (const dispose of disposers) dispose();
						};
					}, []);
					const count = countUnread().get(workspaceId ?? '') ?? 0;
					if (count === 0) return null;
					const label = translate('folders.unread', { n: count });
					return React.createElement(
						'span',
						{
							style: {
								display: 'inline-flex',
								alignItems: 'center',
								gap: 4,
								flex: 'none',
								marginLeft: 4,
								marginRight: 2,
								pointerEvents: 'none',
							},
							role: 'img',
							'aria-label': label,
							title: label,
						},
						React.createElement('i', {
							style: {
								display: 'block',
								width: 8,
								height: 8,
								borderRadius: '50%',
								flex: 'none',
								background: 'var(--dsw-alias-state-success-primary, currentColor)',
							},
						}),
						React.createElement(
							'b',
							{
								style: {
									fontSize: 11,
									lineHeight: '16px',
									fontWeight: 500,
									fontVariantNumeric: 'tabular-nums',
									color: 'var(--dsw-alias-label-secondary, currentColor)',
								},
							},
							String(count),
						),
					);
				}

				/** Whether the patched Workspace browser took the slot seat. */
				let slotActive = false;

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

				// ------------------------------------------------------------ folder marks

				/** Remove every mark the fallback drew, so a slot takeover leaves no duplicate. */
				const clearDrawn = () => {
					if (document.body === null) return;
					for (const badge of document.querySelectorAll(BADGE_SELECTOR)) badge.remove();
				};

				/**
				 * Draw one folder's mark, creating it on first need. The mark sits before
				 * the row's hover actions so it keeps its place when those appear.
				 * @param row - the folder row element.
				 * @param count - unread Sessions in that folder.
				 */
				const paintRow = (row, count) => {
					const existing = row.querySelector(BADGE_SELECTOR);
					if (count === 0) {
						if (existing !== null) existing.remove();
						return;
					}
					let badge = existing;
					if (badge === null) {
						badge = document.createElement('span');
						badge.setAttribute(BADGE_ATTRIBUTE, '');
						badge.setAttribute('role', 'img');
						badge.appendChild(document.createElement('i'));
						badge.appendChild(document.createElement('b'));
						const actions = row.querySelector('[class*="rowActions"]');
						if (actions !== null && actions.parentNode === row) row.insertBefore(badge, actions);
						else row.appendChild(badge);
					}
					const number = badge.lastElementChild;
					const text = String(count);
					if (number !== null && number.textContent !== text) number.textContent = text;
					const description = t('folders.unread', { n: count });
					if (badge.getAttribute('aria-label') !== description) {
						badge.setAttribute('aria-label', description);
						badge.setAttribute('title', description);
					}
				};

				/** Reconcile every folder row on screen with the current counts. */
				const paint = () => {
					if (slotActive || document.body === null) return;
					const counts = countUnread();
					for (const row of document.querySelectorAll(ROW_SELECTOR)) {
						const raw = row.getAttribute(ROW_ATTRIBUTE) ?? '';
						paintRow(row, counts.get(raw.slice(ROW_PREFIX.length)) ?? 0);
					}
				};

				let scheduled = false;
				/** Coalesce repaints into one frame: the sidebar re-renders on every update. */
				const schedule = () => {
					if (scheduled || slotActive) return;
					scheduled = true;
					requestAnimationFrame(() => {
						scheduled = false;
						paint();
					});
				};

				/**
				 * Prefer the declared seat: a patched Workspace browser renders the mark
				 * itself, so the DOM fallback must stand down or it would draw twice.
				 */
				ctx.effect(
					() =>
						ctx.slots.inject(FOLDER_SLOT, () => {
							slotActive = true;
							clearDrawn();
							return ctx.slots.register(
								{ name: FOLDER_SLOT, id: 'unread-folder-mark', order: 10, locale: NS },
								FolderMark,
							);
						}),
					'session-unread: folder slot',
				);

				/**
				 * Fallback for a stock DSH whose folder rows have no seat: decorate the
				 * row in place. It stays inert whenever the slot above took over.
				 */
				ctx.effect(
					() => {
						const style = document.createElement('style');
						style.setAttribute(STYLE_ATTRIBUTE, '');
						style.textContent = STYLE;
						document.head.appendChild(style);
						const observer = new MutationObserver(schedule);
						observer.observe(document.body, { childList: true, subtree: true });
						const disposers = [sessions.list.subscribe(schedule), workspaces.list.subscribe(schedule)];
						const status = sessionService()?.sessionStatus;
						if (status?.subscribe !== undefined) disposers.push(status.subscribe(schedule));
						schedule();
						return () => {
							observer.disconnect();
							for (const dispose of disposers) dispose();
							style.remove();
							clearDrawn();
						};
					},
					'session-unread: folder fallback',
				);
			},
		};
	},
});
