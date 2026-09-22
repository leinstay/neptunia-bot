<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../.github/assets/banner-dark.png">
    <img src="../../.github/assets/banner.png" width="700" alt="Neptunia - AI-движок персонажей для Discord">
  </picture>
</p>
<p align="center"><a href="../../README.md">English</a> | <a href="../zh/README.md">中文</a> | <a href="../ja/README.md">日本語</a> | Русский</p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia-bot/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia-bot" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia-bot/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia-bot" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia-bot/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia-bot" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia-bot/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia-bot" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia-bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia-bot" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

---

Neptunia: локально запускаемый бот для Discord, который играет одного настраиваемого персонажа через LLM и ведёт себя как обычный участник чата. Node.js 20+ с единственной зависимостью (discord.js), любой OpenRouter-совместимый эндпоинт, подключаемая карточка персонажа без правки кода, горячая перезагрузка промптов и конфигурации, память по каждому участнику с отношениями и эпизодами, серверный лорбук, зрение для прикреплённых картинок, однострочные описания медиа от вспомогательной модели, слэш-команды владельца для настройки на лету и режим сухого прогона. В комплекте рабочий пример персонажа; напишите свою карточку для другой персоны.

Персона отвечает на упоминания, ответы и триггеры по имени, иногда игнорируя их. Она вклинивается в разговоры через случайные интервалы и заводит темы в мёртвых каналах. Она запоминает людей, отслеживает отношение от -100 до 100 и учитывает его в ответах. Числовое значение в чате не появляется. Вся конфигурация и промпты перезагружаются на лету; команды владельца настраивают бота прямо из Discord.

Каждый экземпляр обслуживает один сервер, один аккаунт бота, одну личность. Для второго сервера или персонажа запустите вторую копию со своими `.env`, `config.local.json`, `prompts.local/` и `data/`. Discord помечает бот-аккаунты значком APP; движок не скрывает этого.

## Быстрый старт

Создайте приложение Discord на [discord.com/developers](https://discord.com/developers/applications). Включите привилегированный интент **Message Content** на странице Bot. URL приглашения требует оба scope (`scope=bot%20applications.commands`) и `permissions=68672` (просмотр каналов, отправка сообщений, чтение истории, добавление реакций). Если слэш-команды не появились после добавления бота, лог объяснит причину; повторное открытие URL приглашения и прохождение по нему заново исправляет регистрацию без удаления бота.

Получите API-ключ на [OpenRouter](https://openrouter.ai/keys) (или на любом совместимом эндпоинте).

```bash
git clone https://github.com/leinstay/neptunia-bot.git
cd neptunia-bot && npm install
cp .env.example .env
```

Отредактируйте `.env`, указав токен Discord и API-ключ. Создайте `config.local.json` с вашим Discord user ID:

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

Когда `bot.guildId` пуст и бот находится ровно на одном сервере, он привязывается к нему автоматически. Если бот на нескольких серверах, он откажется запускаться. Укажите `bot.guildId` в `config.local.json`.

## Слои промптов

Промпты загружаются из двух директорий:

- `prompts/`: отслеживаемые дефолты движка. Содержит рабочий пример персонажа.
- `prompts.local/`: ваша личность (в gitignore). Файл здесь заменяет одноимённый файл в `prompts/`. `labels.json` объединяется глубоким слиянием, так что вы переопределяете только нужные ключи.

Оба каталога перезагружаются на лету.

### Файлы промптов

| Файл | Обязателен | Назначение |
|---|---|---|
| `system-prompt.md` | да | Как вести себя обычным участником чата, без привязки к персонажу |
| `character-card.md` | да | Личность: кто это, как говорит, что важно |
| `rules.md` | нет | Коррекции владельца на лету, добавляются через `/nep rule add` |
| `format.md` | да | Протокол вывода: теги, которыми модель действует |
| `reply.md` | да | Задача: кто-то обратился к персоне |
| `interject.md` | да | Задача: вклиниться в живой разговор |
| `initiate.md` | да | Задача: нарушить тишину, начать тему |
| `memory.md` | да | Технический промпт для анализатора памяти и отношений |
| `describe.md` | да | Однострочные описания медиа для вспомогательной модели |
| `address.md` | да | Классификатор: адресовано ли необозначенное сообщение персоне |
| `profile.md` | да | Прогрев: профиль одного участника из выборки сообщений |
| `channel.md` | да | Прогрев: заметки о канале из выборки сообщений |
| `server.md` | да | Прогрев: серверные заметки из заметок каналов и сводок участников |
| `labels.json` | да | Все строки, которые код вставляет в промпты (глубокое слияние между слоями) |

**Единственный файл, который нужно переписать: `character-card.md`.** Скопируйте его в `prompts.local/` и напишите свою персону. Всё остальное работает из коробки; при необходимости переопределяйте отдельные файлы.

Анализатор памяти оценивает, как персонаж относится к людям. И анализатор, и прогрев получают вашу карточку персонажа и `rules.md`, поэтому укажите, что ваш персонаж любит и не любит; правило на лету о голосе или оценках влияет на портреты и отношение так же, как карточка.

Плейсхолдеры, ключи `labels.json`, контекстные блоки и теги вывода, которые может использовать каждый файл промпта, описаны в [`docs/prompt-contract.md`](../prompt-contract.md); изменение одной стороны меняет другую.

### Советы

Системный промпт отвечает за естественное звучание, поэтому карточка занимается только личностью. Дайте персонажу мнения и дефолтное настроение вместо уступчивости. Держите образцы реплик короткими и разнообразными; они удерживают стиль в длинных разговорах. Пишите карточку голосом персонажа. Пусть мат несёт смысл, а не заполняет пустоту. Пусть молчание будет настоящим вариантом. Персонаж, который всегда отвечает: самый очевидный признак бота.

## Конфигурация

`config.json` содержит все настройки с дефолтами. `config.local.json` (в gitignore) объединяется глубоким слиянием поверх него. Оба перезагружаются на лету. Полный справочник по всем ключам: [`configuration.md`](configuration.md).

## Начало работы с памятью

При первом запуске, если `warmup.enabled` установлен в true и ни одного профиля ещё нет, движок запускает прогрев, который строит память о людях, каналах и сервере из выборки недавних сообщений. Общий расход токенов ограничен `warmup.maxTokens`. Персона молчит, пока идёт прогрев. Этапы, прогресс, ограничения и команды владельца описаны в [`warmup.md`](warmup.md).

## Сухой прогон

При `features.dryRun: true` бот выполняет весь пайплайн (память, триггеры, вызовы LLM), но никогда не отправляет сообщения или реакции. Вывод попадает в лог (`dry-run: would send` / `dry-run: would react`). Укажите в `bot.dryRunChannelId` приватный канал для читаемого зеркала; всё, что публикуется в этом канале, бот игнорирует. Слэш-команды работают в любом канале, включая зеркало, потому что они не являются сообщениями.

Первый запуск на новом сервере: включите `features.dryRun`, следите за зеркалом или `journalctl -u neptunia-bot -f`, настраивайте на лету, затем `/nep set features.dryRun false`.

## Команды владельца

Одна слэш-команда Discord: `/nep` (имя задаётся в `bot.commandName`). Гильдийные команды, регистрируемые при запуске для обслуживаемого сервера. Все ответы эфемерные; их видит только вызвавший, в любом канале. Полный список подкоманд и управление доступом: [`owner-commands.md`](owner-commands.md).

## Как работает ход

Сообщение проходит фильтры гильдии, канала и собственных сообщений. Если персону вызвали (@упоминание, ответ или триггер по имени), эвристика игнорирования проверяет базовую вероятность с поправками на пустые пинги, повторные теги, спам и балл отношения к вызвавшему. После того как персона ответила кому-то, необозначенные сообщения в этом канале в течение следующих `mention.followUpMinutes` минут отправляются классификатору на роли модели `followUp` (по умолчанию медиа-модель), который определяет, продолжается ли обмен; три `no` подряд закрывают окно. `features.followUp` отключает это. Спонтанные ходы срабатывают от хаотичного таймера или от шанса подслушивания на каждое сообщение. Персона не заговорит без повода в канале, молчащем более `spontaneous.maxChannelSilenceHours` часов; прямой пинг при этом по-прежнему получит ответ.

Персона пишет один ответ за раз на весь сервер. Пинг в том же канале, пока она уже отвечает, пропускается; пропущенные сообщения попадут в транскрипт при сборке следующего ответа. Прямой пинг в другом канале (@упоминание или ответ на её сообщение, не триггер по имени) удерживается, один на канал, в не более чем `mention.maxPending` каналах на `mention.pendingMinutes` минут; новый пинг в том же ожидающем канале заменяет предыдущий. Когда текущий ответ завершается, персона переключается на канал после короткой паузы (`mention.switchDelayMs`) и отвечает из контекста разговора; обычная вероятность игнорирования применяется. Триггеры по имени и срабатывания подслушивания, пришедшие во время занятости, пропускаются. При `mention.oneAtATime: false` каждый канал обрабатывается независимо. Персона никогда не пишет и не реагирует там, где у неё нет права Send Messages, проверяя это до отправки запроса к LLM; такие каналы по-прежнему читаются и запоминаются.

Ход собирает транскрипт канала и соседние каналы, затем строит один запрос к LLM в рамках бюджета токенов. Секции заполняются в порядке приоритета: системный промпт и задача никогда не обрезаются; далее профиль вызвавшего, серверные привычки и факты о себе, карта каналов, транскрипт (новейшие сначала), другие профили и соседние каналы. Модель видит карту каналов сервера (назначение, темы, тон, уровень активности), текущий канал отмечен. Каждая запись канала также содержит факты, которые ведёт код: количество сообщений, первое и последнее сообщение, активность за последние 30 дней и самых активных авторов; прогрев заполняет их из истории канала, а живой трафик поддерживает актуальность.

Модель отвечает тегами `<think>` (скрытое планирование), `<msg>` (1–3 сообщения; `reply="#87"` отвечает на строку транскрипта), `<react>` (одна эмодзи-реакция) или `<skip/>` (молчание). После разбора набор текста симулируется с человеческой скоростью, а `@nick` в выводе становится реальным упоминанием.

Анализатор памяти запускается как отдельный вызов LLM, когда накопится достаточно сообщений. Он получает карточку персонажа и оценивает каждого человека глазами персонажа, возвращая изменения отношений, изменения профилей, наблюдения по каналам и серверные заметки. Портрет характера и манеры речи участника строится из каналов в `memory.mainChannelIds`; если список пуст, учитываются все каналы. Профили обновляются инкрементально: анализатор возвращает только изменившееся, а сохранённые факты не пересказываются. Характер и стиль: прозаические абзацы, которые целиком пишет профильный промпт во время прогрева и обновляет из недавних сообщений, когда анализатор отмечает пробел или противоречие. Интересы и детали: отдельные элементы, которые подтверждаются при повторном появлении в другой раз; на каждого человека хранится больше элементов, чем показывается, ранжированных по частоте и новизне с весом, который убывает со временем. Интересы, которые давно не встречались, показываются персоне как устаревшие. Сохранённая память ссылается на участников по id, а текущее имя подставляется при использовании памяти, поэтому переименования не ломают сохранённые заметки. Персона также запоминает, как люди в чате называют друг друга, и узнаёт участника, упомянутого по имени или псевдониму, даже если тот не участвует в разговоре.

## Эпизоды и лорбук

Анализатор памяти ведёт два типа долгосрочных заметок помимо профилей.

Эпизоды: моменты, которые персона запоминает о конкретных людях. Оскорбление, доброта, обещание, спор, общая шутка, просьба сделать что-то или никогда не делать. Анализатор добавляет их в профиль человека с датой, кратким описанием, иногда словами самого человека и весом от 1 до 5. Самые тяжёлые живут дольше всех; когда профиль достигает `memory.maxEpisodes`, сначала вытесняются самые лёгкие, затем самые старые. Показываются только эпизоды вызвавшего, внутри блока `<people>`.

Лорбук хранит серверные знания, которые переживают любой разговор: события, повторяющиеся персонажи, длительные истории, вражды, традиции. Каждая запись имеет заголовок, набор ключевых слов и короткий текст. Код сканирует последние `lore.scanMessages` сообщений на совпадения ключевых слов и включает до `lore.maxMatches` записей в блок `<lore>`; записи с пометкой `always` появляются каждый раз. Сотни записей могут существовать с ничтожными затратами, потому что показываются только совпавшие.

Анализатор добавляет и обновляет записи лорбука самостоятельно, но никогда не трогает записи, добавленные владельцем через команды `/nep lore`. Данные лорбука хранятся в `data/guilds/<id>/lore.json`.

## Зрение и медиа

Строки транскрипта содержат маркеры медиа в скобках: картинки, GIF, видео, стикеры, кастомные эмодзи, голосовые сообщения, аудиофайлы, ссылки, превью текстовых файлов и пересланные сообщения. Пересланные сообщения из другого канала того же сервера указывают канал-источник. Что воспринимает персона, зависит от двух настроек.

`features.vision` прикрепляет картинки из вызвавшего сообщения, из сообщения, на которое оно отвечает, и несколько последних в канале к запросу LLM как изображения, уменьшенные через медиа-прокси Discord. Бот скачивает каждую картинку сам и отправляет её инлайн как данные, потому что Discord отказывает в загрузках от провайдера модели; картинки больше `context.vision.maxBytes` или медленнее `context.vision.fetchTimeoutMs` пропускаются. Персона видит их напрямую. Настройки находятся в `context.vision`.

`features.mediaDescriptions` (включён по умолчанию) запускает вспомогательную модель (`media.model`), которая пишет однострочное описание для картинок, кадров GIF, постеров видео, стикеров, кастомных эмодзи и превью ссылок. Каждое вложение описывается один раз и кэшируется. Описания поступают в транскрипт чата, анализатор памяти и прогрев, чей бюджет токенов оплачивает описания при прогреве. Промпт дескрайбера: `prompts/describe.md`. Настройки находятся в `media`.

Стикеры и кастомные эмодзи постоянно повторяются, поэтому кэшируются по id и почти ничего не стоят после первого описания. При `features.vision` стикер вызвавшего сообщения прикрепляется как картинка. Встроенные анимированные стикеры Discord: Lottie-анимации, а не картинки, поэтому они всегда остаются только именем.

Блок `<senses>` в пользовательском сообщении сообщает персоне, что она может и не может воспринимать при текущей конфигурации. Персона доверяет этому блоку и никогда не утверждает, что видела, слышала или открывала что-то сверх указанного.

Персона не может смотреть видео или слушать аудио; ей доступны имя, длительность и в лучшем случае описание одного кадра. Голосовые сообщения показывают только длительность. Ссылки показывают сайт, заголовок и фрагмент из эмбеда Discord, но не саму страницу.

## Стоимость и конфиденциальность

Каждый ход занимает один запрос к LLM; обновление памяти добавляет второй. Стоимость зависит от модели и эндпоинта; `llm.model` и `llm.baseUrl` принимают любые совместимые значения. Дневной лимит (`llm.maxRequestsPerDay`) предотвращает неконтролируемые расходы.

`data/` содержит профили участников, баллы отношений, наблюдения по каналам и серверные паттерны. Всё остаётся на вашей машине, включено в gitignore и отправляется в LLM только как контекст. Анализатору дана инструкция не хранить конфиденциальные данные. `/nep memory forget` полностью удаляет профиль.

Предупредите участников сервера. Они должны знать, что их сообщения обрабатываются LLM и что бот ведёт заметки.

## Запуск как сервис

Пример юнита systemd: `deploy/neptunia-bot.service`. Настройте `WorkingDirectory` и `User`, затем установите:

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neptunia-bot
```

Приватный слой живёт рядом с кодом: `.env`, `config.local.json`, `prompts.local/`, `data/`. Обновление:

```bash
git pull && sudo systemctl restart neptunia-bot
```

Перезапуск ничего не теряет; всё состояние на диске. Перезапуск нужен только после изменений кода в `src/`. Правки промптов и конфигурации применяются на лету.

Память живёт в процессе и записывается в `data/`; редактирование этих файлов при работающем боте небезопасно, так как следующая запись перезапишет изменение. Для ручного редактирования памяти: `/nep pause`, редактируйте файлы, `/nep resume`. Пауза останавливает всю активность, сбрасывает память на диск и выгружает её; запущенный прогрев приостанавливается после текущего запроса. Состояние сохраняется: после перезапуска бот возвращается на паузе, и прогрев не стартует автоматически до возобновления. `/nep resume` валидирует каждый JSON-файл в `data/` и отказывается, если хоть один не парсится, называя проблемные; иначе перезагружает память и продолжает, включая прогрев с места остановки. Команды чтения и конфигурации работают на паузе; команды записи памяти отклоняются. `/nep status` показывает состояние паузы.

## Участие в разработке

Приветствуются issues и pull requests; сначала прочитайте `CONTRIBUTING.md`. Целевая ветка `main`, одно изменение на pull request, тесты проходят через `npm test`, только на английском. Контракт между файлами промптов и кодом описан в `docs/prompt-contract.md`. Изменение одной стороны меняет другую в том же pull request. Движок остаётся нейтральным к персонажу; поведение конкретного персонажа принадлежит каталогу `prompts.local/` его деплоя. Отчёты о безопасности отправляются через `SECURITY.md`, а не через публичные issues.

## Тесты

```bash
npm test
```

Запускается через `node --test`. Сеть или подключение к Discord не требуются. Та же команда выполняется в CI при каждом pull request.

## Структура проекта

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN and OPENROUTER_API_KEY
prompts/
  system-prompt.md         how to behave like an ordinary chat member
  character-card.md        the personality (working example)
  rules.md                 owner's live corrections
  format.md                output tags the model uses
  reply.md                 task: someone called you
  interject.md             task: jump into a conversation
  initiate.md              task: start a topic
  memory.md                prompt for the memory analyzer
  describe.md              prompt for the media describer
  address.md               classifier for follow-up messages
  profile.md               warmup: one member's profile from a message sample
  channel.md               warmup: channel notes from a message sample
  server.md                warmup: server-level notes from channel notes and member summaries
  labels.json              every code-inserted string in prompts
prompts.local/             your personality (gitignored)
docs/
  prompt-contract.md       the contract between prompt files and code
  en/
    configuration.md       full reference for every config key
    owner-commands.md      every subcommand and the access grants
    warmup.md              the warmup: stages, progress, rails, commands
  zh/                      Chinese
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ja/                      Japanese
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ru/                      Russian
    README.md
    configuration.md
    owner-commands.md
    warmup.md
src/
  index.js                 entry point, wiring, timers, shutdown
  config.js                .env parser, config loader, deepMerge
  hot.js                   live config + prompts via fs.watch
  log.js                   structured JSON logging
  admin.js                 owner commands
  llm/
    tokens.js              token estimation with self-calibration
    budget.js              priority-ordered section trimming
    openrouter.js          chat completions, safety rails
    parse.js               output tags to actions
  discord/
    guild.js               single-guild resolution
    commands.js            slash commands, registration, interaction adapter
    events.js              message pipeline
    collect.js             channel history, neighbours, permissions
    format.js              transcript lines, time gaps, tempo
    media.js               media classification, label selection, proxy URLs
    fetch-image.js         download and cache images for inline LLM requests
  behavior/
    mention.js             call detection, ignore heuristics
    prompt.js              request builder with token budget
    turn.js                one turn: collect, build, call, act
    spontaneous.js         chaotic timer, eavesdrop
    pending.js             pending direct pings while the persona is busy
  memory/
    store.js               JSON file persistence, atomic writes
    update.js              batch memory updates
    affinity.js            relationship score logic
    interests.js           remembered interests: sightings, confirmation, eviction
    details.js             remembered details: sightings, confirmation, eviction
    aliases.js             remembered aliases: sightings, confirmation, eviction
    episodes.js            remembered episodes: append, weight-based eviction
    channels.js            channel map rendering, activity verdicts
    mentions.js            member-id tokens in stored text: toTokens and fromTokens
    clamp.js               text clamping: soft limits, sentence boundaries, safe member tokens
    ranking.js             shared ranking for interests and details: frequency, recency, decay
    lore.js                lorebook logic: key matching, entry selection
    describe.js            media describer: one picture in, one cached caption out
    warmup.js              sample-based memory warmup
tests/                     node --test, pure-function unit tests
deploy/
  neptunia-bot.service     example systemd unit
data/                      persistent state (gitignored, created at runtime)
  state.json               scheduler times, token calibration, daily request counter, warmup progress
  guilds/<id>/guild.json   server habits, in-jokes, the persona's self-claims
  guilds/<id>/buffer.json  messages observed since the last memory update
  guilds/<id>/media.json   media description cache
  guilds/<id>/users/       per-member profiles and relationships
  guilds/<id>/channels/    channel observations from the analyzer
  guilds/<id>/lore.json    lorebook entries
```
