# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [1.0.0] — 2026-11-11

Первый публичный релиз.

### Added

- Пункт «Отметить как непрочитанное» / «Отметить как прочитанное» в контекстном меню
  строки сессии (`target: 'session'`, `order: 350`).
- Возврат зелёного кружка «Завершено» через набор `uiSession.completionUnread` и
  `publishStatus()`, поэтому строка обновляется без перезагрузки.
- Отметки в `localStorage` (ключ `dsh.sessionUnreadMarks.v1`), переживающие перезагрузку
  страницы и перезапуск приложения.
- Иконки пункта в слоте `contextMenu.icon`: `StateDot state="done"` — та же точка, что в
  строке, — и `IconCheckCircleOutline`.
- Локали `ru`, `en`, `zh` с ключами `mark.unread` и `mark.read`.
- Пакет оформлен как самостоятельный bundle: `dsh.bundle.patch` + `dsh.client`
  (`platform: "web"`, `inject` трёх клиентских пакетов).
