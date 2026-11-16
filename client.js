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
				'folders.waiting': 'Sessions waiting for an answer: {n}',
			},
			ru: {
				'mark.unread': 'Отметить как непрочитанное',
				'mark.read': 'Отметить как прочитанное',
				'folders.unread': 'Непрочитанных сессий: {n}',
				'folders.waiting': 'Ожидают ответа: {n}',
			},
			zh: {
				'mark.unread': '标记为未读',
				'mark.read': '标记为已读',
				'folders.unread': '未读会话：{n}',
				'folders.waiting': '等待回答的会话：{n}',
			},
		};

		/** The two things a folder row reports, in the order it draws them. */
		const FOLDER_KINDS = ['waiting', 'unread'];

		/** Folder colors: the sidebar's own warning and completion tokens. */
		const FOLDER_DOT_COLOR = {
			waiting: 'var(--dsw-alias-state-warn-primary, #d99a2b)',
			unread: 'var(--dsw-alias-state-success-primary, currentColor)',
		};

		/** A folder with nothing to report. */
		const NO_MARKS = { waiting: 0, unread: 0 };

		/**
		 * Folder marks borrow the row's geometry: one dot-and-count pair per kind,
		 * the waiting pair first because an unanswered Session outranks a finished one.
		 */
		const STYLE = [
			BADGE_SELECTOR + ' {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 6px;',
			'  flex: none;',
			'  margin-left: 4px;',
			'  margin-right: 2px;',
			'  pointer-events: none;',
			'}',
			BADGE_SELECTOR + ' > span {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 3px;',
			'}',
			BADGE_SELECTOR + ' > span[hidden] {',
			'  display: none;',
			'}',
			BADGE_SELECTOR + ' i {',
			'  display: block;',
			'  width: 8px;',
			'  height: 8px;',
			'  border-radius: 50%;',
			'  flex: none;',
			'  background: var(--dsw-alias-state-success-primary, currentColor);',
			'}',
			BADGE_SELECTOR + ' span[data-kind="waiting"] i {',
			'  background: var(--dsw-alias-state-warn-primary, #d99a2b);',
			'}',
			BADGE_SELECTOR + ' b {',
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
				 * Count what each folder row must report, from the very status store the
				 * sidebar draws its own dots from, so a folder never promises a dot that
				 * is absent inside it.
				 *
				 * Waiting counts the Sessions whose pending interaction is unanswered;
				 * unread counts the finished ones the completion reminders still hold.
				 * Each has its own number, and a Session can be in only one of them: a
				 * Session that waits has not finished.
				 * @returns map of workspace id ('' for ungrouped) to its counts.
				 */
				const collectFolderMarks = () => {
					const marks = new Map();
					const list = listOf();
					const rows = list.byId ?? {};
					const snapshot = workspaces.list.getSnapshot();
					const archived = new Set(snapshot.archivedSessionIds ?? []);
					const unread = sessionService()?.completionUnread;
					const statuses = sessionService()?.sessionStatus?.getSnapshot?.();
					const statusOf = (sessionId) => (statuses instanceof Map ? statuses.get(sessionId) : undefined);

					/** Archived, blank and subagent Sessions have no row of their own. */
					const listed = (sessionId) => {
						if (archived.has(sessionId)) return false;
						const row = rows[sessionId];
						return row !== undefined && row.blank !== true && row.origin !== 'subagent';
					};
					/**
					 * The interaction kinds the Session row draws a warning dot for. Any
					 * other kind draws nothing there, so it must not light a folder either.
					 */
					const visiblePending = (status) => {
						const kind = status?.pendingInteraction?.kind;
						return kind === 'approval' || kind === 'plan-review' || kind === 'question';
					};
					/** A Session waits while such an interaction is still unanswered. */
					const waits = (sessionId) => visiblePending(statusOf(sessionId));

					const membership = new Map();
					const accounted = new Set();
					for (const item of snapshot.items ?? []) {
						const ids = [];
						for (const sessionId of item.sessionIds ?? []) {
							accounted.add(sessionId);
							if (listed(sessionId)) ids.push(sessionId);
						}
						membership.set(item.workspaceId, ids);
					}
					// Sessions outside every folder land on the ungrouped row.
					membership.set(
						'',
						(list.ids ?? []).filter((id) => !accounted.has(id) && listed(id)),
					);

					const workspaceOf = new Map();
					for (const [workspaceId, ids] of membership) {
						for (const id of ids) workspaceOf.set(id, workspaceId);
					}

					/**
					 * Waiting Sessions per folder, keyed by the row that carries the dot:
					 * a subagent's approval is counted once, on the Session above it.
					 */
					const waiting = new Map();
					const addWaiting = (workspaceId, rowId) => {
						let ids = waiting.get(workspaceId);
						if (ids === undefined) {
							ids = new Set();
							waiting.set(workspaceId, ids);
						}
						ids.add(rowId);
					};
					for (const [workspaceId, ids] of membership) {
						for (const id of ids) if (waits(id)) addWaiting(workspaceId, id);
					}
					for (const [sessionId, status] of statuses instanceof Map ? statuses : []) {
						if (!visiblePending(status)) continue;
						if (workspaceOf.has(sessionId) || archived.has(sessionId)) continue;
						let cursor = rows[sessionId];
						for (let depth = 0; cursor !== undefined && depth < 12; depth += 1) {
							const parentId = cursor.parentId;
							if (parentId === undefined) break;
							if (workspaceOf.has(parentId)) {
								addWaiting(workspaceOf.get(parentId), parentId);
								break;
							}
							cursor = rows[parentId];
						}
					}

					for (const [workspaceId, ids] of membership) {
						let finished = 0;
						for (const id of ids) {
							// The row shows one primary dot: waiting and running both outrank completion.
							if (rows[id].running === true || waits(id)) continue;
							if (unread instanceof Set && unread.has(id)) finished += 1;
						}
						const awaiting = waiting.get(workspaceId)?.size ?? 0;
						if (finished > 0 || awaiting > 0) marks.set(workspaceId, { waiting: awaiting, unread: finished });
					}
					return marks;
				};

				/**
				 * One dot-and-count pair for the React seat.
				 * @param kind - 'waiting' or 'unread'.
				 * @param count - how many Sessions it stands for.
				 * @param label - the localized description.
				 * @returns the segment element.
				 */
				const folderSegment = (kind, count, label) =>
					React.createElement(
						'span',
						{ 'data-kind': kind, title: label },
						React.createElement('i', {
							style: {
								display: 'block',
								width: 8,
								height: 8,
								borderRadius: '50%',
								flex: 'none',
								background: FOLDER_DOT_COLOR[kind],
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
					const counts = collectFolderMarks().get(workspaceId ?? '') ?? NO_MARKS;
					const parts = FOLDER_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({
						kind,
						count: counts[kind],
						label: translate(kind === 'waiting' ? 'folders.waiting' : 'folders.unread', { n: counts[kind] }),
					}));
					if (parts.length === 0) return null;
					const label = parts.map((part) => part.label).join('; ');
					return React.createElement(
						'span',
						{
							style: {
								display: 'inline-flex',
								alignItems: 'center',
								gap: 6,
								flex: 'none',
								marginLeft: 4,
								marginRight: 2,
								pointerEvents: 'none',
							},
							role: 'img',
							'aria-label': label,
							title: label,
						},
						...parts.map((part) => folderSegment(part.kind, part.count, part.label)),
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
				 * Write one segment's count, hiding the pair while the folder has none.
				 * @param segment - the dot-and-count pair.
				 * @param count - how many Sessions it stands for.
				 * @param label - the localized description.
				 */
				const paintSegment = (segment, count, label) => {
					if (count === 0) segment.setAttribute('hidden', '');
					else segment.removeAttribute('hidden');
					const number = segment.lastElementChild;
					const text = String(count);
					if (number !== null && number.textContent !== text) number.textContent = text;
					if (segment.getAttribute('title') !== label) segment.setAttribute('title', label);
				};

				/**
				 * Draw one folder's marks, creating them on first need. The mark sits
				 * before the row's hover actions so it keeps its place when those appear.
				 * @param row - the folder row element.
				 * @param counts - that folder's waiting and unread counts.
				 */
				const paintRow = (row, counts) => {
					const existing = row.querySelector(BADGE_SELECTOR);
					if (counts.waiting + counts.unread === 0) {
						if (existing !== null) existing.remove();
						return;
					}
					let badge = existing;
					if (badge === null) {
						badge = document.createElement('span');
						badge.setAttribute(BADGE_ATTRIBUTE, '');
						badge.setAttribute('role', 'img');
						for (const kind of FOLDER_KINDS) {
							const segment = document.createElement('span');
							segment.setAttribute('data-kind', kind);
							segment.appendChild(document.createElement('i'));
							segment.appendChild(document.createElement('b'));
							badge.appendChild(segment);
						}
						const actions = row.querySelector('[class*="rowActions"]');
						if (actions !== null && actions.parentNode === row) row.insertBefore(badge, actions);
						else row.appendChild(badge);
					}
					const labels = [];
					for (const kind of FOLDER_KINDS) {
						const count = counts[kind];
						const label = t(kind === 'waiting' ? 'folders.waiting' : 'folders.unread', { n: count });
						paintSegment(badge.querySelector('[data-kind="' + kind + '"]'), count, label);
						if (count > 0) labels.push(label);
					}
					const description = labels.join('; ');
					if (badge.getAttribute('aria-label') !== description) {
						badge.setAttribute('aria-label', description);
						badge.setAttribute('title', description);
					}
				};

				/** Reconcile every folder row on screen with the current counts. */
				const paint = () => {
					if (slotActive || document.body === null) return;
					const counts = collectFolderMarks();
					for (const row of document.querySelectorAll(ROW_SELECTOR)) {
						const raw = row.getAttribute(ROW_ATTRIBUTE) ?? '';
						paintRow(row, counts.get(raw.slice(ROW_PREFIX.length)) ?? NO_MARKS);
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
