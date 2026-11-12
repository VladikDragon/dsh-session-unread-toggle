# dsh-session-unread-toggle

[![release](https://img.shields.io/github/v/release/VladikDragon/dsh-session-unread-toggle?label=release)](https://github.com/VladikDragon/dsh-session-unread-toggle/releases)
[![license](https://img.shields.io/github/license/VladikDragon/dsh-session-unread-toggle)](LICENSE)

Пункт контекстного меню сессии, который возвращает зелёный кружок «Завершено» —
чтобы вернуться к разговору позже.

> *English summary: a DeepSeek Harness web plugin that adds a right-click action to a
> finished sidebar Session, restoring the green completion dot (or clearing it), so a
> conversation you have already read can be marked unread again.*

## Что делает

Когда сессия завершает работу, в списке слева появляется зелёный кружок «Завершено».
Открытие сессии снимает его. Плагин добавляет в контекстное меню строки (правая кнопка
мыши или кнопка «...») пункт:

- **Отметить как непрочитанное** — кружок возвращается и держится, пока сессию снова не
  откроют;
- **Отметить как прочитанное** — снимает отметку.

Если отметить сессию, открытую прямо сейчас, кружок появится, как только вы из неё
выйдете, и исчезнет при следующем открытии — отметка работает как «вернуться к этому
позже».

Пункт показывается только для сессий, которые уже запускали запрос, не выполняются
сейчас и не лежат в архиве. Отметки живут в браузере (`localStorage`, ключ
`dsh.sessionUnreadMarks.v1`), поэтому переживают перезагрузку страницы и перезапуск
приложения, синхронизируются между вкладками и окнами и не теряются при архивации
сессии.

## Установка

Плагин ставится в профиль как обычный пакет:

```
dsh plugin --profile desktop add github:VladikDragon/dsh-session-unread-toggle
```

После установки добавьте его в `dsh.profile.bundles` профиля — через менеджер плагинов
или вручную в `~/.dsh/profiles/<профиль>/package.json`:

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-unread-toggle"]
  }
}
```

Локальная разработка — из клона:

```
git clone https://github.com/VladikDragon/dsh-session-unread-toggle
dsh plugin --profile desktop add file:C:/path/to/dsh-session-unread-toggle
```

Перезапуск приложения нужен только при добавлении нового **пакета**. Правки уже
подключённого плагина подхватываются выключением и включением его строки в менеджере
плагинов.

## Как это работает

```
package.json        манифест: dsh.bundle.patch + dsh.client (platform web)
cordis.patch.yml    одна строка Loader с id session-unread-toggle
index.js            host-половина: пустой apply(), нужен только чтобы у плагина
                    была строка на стороне хоста
client.js           браузерный бандл: пункт контекстного меню и его иконки
```

Клиентская половина объявляется в `package.json` и зависит от трёх пакетов:

```json
"dsh": {
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": [
      "@deepseek-ai/dsh-client-ui-session",
      "@deepseek-ai/dsh-client-ui-workspace",
      "@deepseek-ai/dsh-client-ui-context-menu"
    ]
  }
}
```

`ui-session` объявляет сервис `uiSession`, `ui-context-menu` — реестр пунктов меню и слот
`contextMenu.icon`, `ui-workspace` — слот строки сессии, из которого открывается меню.
Сами сервисы `sessions` и `workspaces` приходят из ядра и контроллера рабочих
пространств. `inject` обязателен: без него регистрация пришлась бы на сервисы и слоты,
которых ещё нет.

### Отметка

Кружок в строке рисуется по `status.completionUnread` из сервиса `uiSession`, а сам набор
живёт только в памяти вкладки и очищается, как только сессию открывают. Плагин пишет
отметку прямо в `uiSession.completionUnread` и вызывает `publishStatus()`, поэтому строка
обновляется без перезагрузки.

Свой список отметок в `localStorage` нужен, чтобы пережить перезагрузку: сверка с
набором сервиса идёт при каждом изменении списка сессий, при публикации
`uiSession.sessionStatus` и сразу при запуске плагина, поэтому кружок возвращается и
после перезагрузки страницы, и после завершения сессии, которую отметили запущенной.

Отметки синхронизируются между вкладками и окнами через событие `storage`: отметка,
поставленная в одном окне, появляется в остальных, а снятая — исчезает везде. Плагин
помнит, какие напоминания добавил сам, и снимает только их, не трогая кружок, который
поднял сам сервис сессий.

Архивация отметку не удаляет: пока сессия в архиве, кружка нет, а при восстановлении из
архива он возвращается. Отметки удалённых сессий снимаются, как только список сессий
загружен.

### Меню

Меню — стандартный `ctx.contextMenus.register({ target: 'session' })`: пункт
`session.unread` с `order: 350` пересчитывается по снимкам списка сессий, архива и своих
отметок. Иконки пункта — две ячейки слота `contextMenu.icon`: зелёная точка
`StateDot state="done"` (та же, что в строке) для «Отметить как непрочитанное» и
`IconCheckCircleOutline` для «Отметить как прочитанное».

## Локаль

Словари лежат прямо в `client.js` и регистрируются в namespace `sessionUnreadToggle`:

```js
ctx.locale.register('sessionUnreadToggle', DICTIONARIES)
```

Ключей два — `mark.unread` и `mark.read`; языки — `ru`, `en`, `zh`.

## Ограничения

- Только веб-клиент (`platform: "web"`); в TUI пункта нет.
- Отметка опирается на поле `completionUnread` сервиса `uiSession`. Это не публичный
  контракт: если DSH переименует поле, плагин перестанет показывать кружок, но не
  сломает страницу.
- Отметки хранятся в браузере: другой браузер или профиль их не увидит.
- Пункт не показывается для выполняющихся, пустых и субагентских сессий, а также для
  сессий без единого запроса и для архива.

## Разработка

Сборки нет: `client.js` — обычный скрипт, который загружается загрузчиком модулей хоста
и получает `react` и примитивы через `require`. Правки применяются перезапуском
приложения; проверить синтаксис можно `node --check client.js`.

Тесты идут без браузера и без DSH: `test/client.test.cjs` подменяет `sessions`,
`workspaces` и `uiSession` макетами и прогоняет сценарии отметок.

```
npm test
```

## Лицензия

MIT — см. [LICENSE](LICENSE).
