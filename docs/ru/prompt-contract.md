# Контракт промптов

Где файлы промптов встречаются с кодом (`src/behavior/prompt.js`, `src/llm/parse.js`, `src/discord/format.js`,
`src/memory/update.js`, `src/memory/channels.js`, `src/memory/warmup.js`). Меняйте одну сторону только вместе с
другой. Рабочий процесс описан в `CONTRIBUTING.md`.

## Слои

| Директория | В репозитории | Содержимое |
|---|---|---|
| `prompts/` | да | Дефолты движка на английском + нейтральный пример персонажа. Работает из коробки |
| `prompts.local/` | нет | Переопределения конкретного развёртывания: файл заменяет одноимённый; `labels.json` объединяется глубоким слиянием |

Оба слоя перезагружаются на лету. `/nep rule add` пишет в `prompts.local/rules.md` (за основу берётся дефолт), никогда в `prompts/`.
Все инструкции в обоих слоях на английском; речевые образцы персонажа могут быть на языке, на котором он говорит.

## Файлы

| Файл | Обязателен | Назначение | Плейсхолдеры |
|---|---|---|---|
| `system-prompt.md` | да | Правила поведения обычного участника чата, без привязки к персонажу: длина, анти-AI-правила, использование контекста, отношение к людям, границы. Указывает, что карточка важнее по голосу | `{{name}}` |
| `character-card.md` | да | Личность: кто, характер, голос и язык, мета-уровень, **что заслуживает и теряет расположение** (считывается анализатором), речевые образцы. Единственный файл, который полностью переписывается при развёртывании | `{{name}}` |
| `rules.md` | нет | Правки владельца на лету, перекрывают два предыдущих файла. **Должен заканчиваться маркированным списком под последним заголовком `## `.** Код дописывает строки `- …` | `{{name}}` |
| `format.md` | да | Протокол вывода | нет |
| `reply.md` | да | Задача: кто-то позвал персонажа | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | да | Задачи: вклиниться в живой разговор / начать тему в молчащем канале | `{{name}}` |
| `forced.md` | нет | Добавляется после промпта режима при принудительном ходе (`/nep interject`, `/nep initiate`). Отменяет вариант `<skip/>` по умолчанию | `{{name}}` |
| `memory.md` | да | Внеролевой промпт потокового анализатора: точечные правки памяти по живым батчам | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` |
| `profile.md` | да | Прогрев / обновление портрета: профиль одного участника из выборки сообщений | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | да | Прогрев: заметки о канале из выборки сообщений | `{{fieldChars}}` |
| `server.md` | да | Прогрев: серверные заметки из заметок каналов и сводок участников | `{{name}}` `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | да | Внеролевой промпт модели описаний медиа (`features.mediaDescriptions`): одна картинка на входе, одна строка на выходе: что изображено, любой читаемый текст, на языке чата. Без мнений, без разметки | нет |
| `describe-video.md` | да | Внеролевой промпт модели описаний видео (`features.videoDescriptions`): один видеоклип на входе (со звуком), полное описание настраиваемой длины на выходе: кто появляется, что говорится (ключевые фразы цитатой), текст на экране, что происходит визуально, музыка/звук при необходимости. Без карточки персонажа | `{{maxChars}}` |
| `rewatch.md` | да | Классификатор: нужно ли персонажу пересмотреть видео или повторить загрузку незагрузившегося (`features.videoRewatch`). Получает нумерованный список недавних видео с их статусом и новое сообщение. Выход: ОДНА строка: `<number> \| <question>`, `<number> \| retry` или `none` | `{{name}}` |
| `rewatch-answer.md` | да | Внеролевой промпт для повторного просмотра: видеомодель смотрит клип ещё раз и отвечает на один вопрос. Те же язык и правила ограничений, что у `describe-video.md`. Без карточки персонажа | `{{question}}` `{{maxChars}}` |
| `address.md` | да | Классификатор: адресовано ли сообщение без обращения персонажу | `{{name}}` |
| `lookup.md` | нет | Классификатор: нужно ли персонажу искать в интернете, чтобы ответить на сообщение (`features.webLookup`). Получает короткий транскрипт и блок `<candidate>`. Выход: ОДНА строка: поисковый запрос (обычные слова, не более 12) или `none` | `{{name}}` |
| `read-link.md` | нет | Внеролевой промпт для чтения ссылок (`features.webLookup`, `web.links.enabled`): сжать загруженную страницу в один абзац. Получает заголовок и тело страницы. Без карточки персонажа | `{{maxChars}}` |
| `search-summary.md` | нет | Внеролевой промпт для конденсатора поиска (`features.webLookup`, `web.search.enabled`): сжать нумерованные результаты поиска в одну заметку со встроенными ссылками на источники. Без карточки персонажа | `{{query}}` `{{maxChars}}` |
| `labels.json` | да | Все строки, которые КОД вставляет в промпт. Ключи фиксированы ниже, формулировки определяет автор текстов | см. ниже |

`{{name}}` отображаемое имя бота · `{{author}}` отображаемое имя вызвавшего · `{{trigger}}` одно из значений `labels.triggers.*` ·
`{{target}}` индекс вызвавшего сообщения (`#87`).
Системное сообщение = `system-prompt` + `character-card` + `rules` + `format`. Для анализатора: только `memory.md`.
При принудительном ходе (`/nep interject`, `/nep initiate`) `forced.md` добавляется после промпта режима, если файл существует.
Анализатор и промпты прогрева `profile.md` и `server.md` получают карточку персонажа и `rules.md` как блок
`<character>` в пользовательском сообщении. `channel.md`, `describe.md`, `describe-video.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md` и `search-summary.md` карточку не получают.

`{{guildFieldChars}}` равен `fieldChars * 2`, лимит, до которого код обрезает серверные паттерны и зачины разговоров.
`{{maxEpisodes}}` определяет общее количество хранимых эпизодов на человека. Оба заполняются из конфигурации, но не
используются дефолтными промптами; пользовательский `memory.md` может на них ссылаться.

## Блоки

Блоки пользовательского сообщения. Пустые опускаются; порядок ниже соответствует порядку в запросе.

| Блок | Содержимое |
|---|---|
| `<now>` | Дата, день недели, время в часовом поясе `config.bot.timezone`, отформатированные через `labels.locale` |
| `<senses>` | Что персонаж может и чего не может воспринимать ПРЯМО СЕЙЧАС. Генерируется из текущей конфигурации: какие картинки он видит сам, какие приходят описанием от вспомогательной модели, к чему слеп и глух. Поэтому он никогда не притворяется, что посмотрел видео, и может пошутить об этом в своей манере |
| `<about_chat>` | Как здесь общаются, как заводят и подхватывают разговоры, внутренние шутки, то, чему люди научили персонажа |
| `<server>` | ТЕКУЩИЙ канал полностью (категория и тема Discord, назначение, о чём пишут, тон, активность, последнее сообщение, самые активные авторы; отмечен `labels.server.currentMark`), затем только те соседние каналы, которые дали сообщения в `<other_channels>` этого хода; никаких других каналов |
| `<lore>` | Записи серверного лорбука, чьи ключевые слова встречаются в последних сообщениях (плюс записи с пометкой always): события, повторяющиеся персонажи, длительные истории. Как лорбук: записей могут быть сотни, показываются только подходящие |
| `<self_facts>` | Что персонаж утверждал о себе |
| `<people>` | Профили участников; вызвавший первым, отмечен `labels.profile.interlocutorMark`; каждый с отношением персонажа, а для вызвавшего ещё и **эпизоды**: моменты, которые персонаж помнит о них двоих, с датами и короткими цитатами |
| `<other_channels>` | До `context.neighborMessages` сообщений на соседний канал, не старше `context.neighborMaxAgeMinutes` |
| `<lookup>` | Что персонаж нашёл в интернете на этом ходу (`features.webLookup`): запрос, сжатый ответ и сайты-источники, или строка «ничего не найдено». Появляется только когда классификатор поиска сработал и поиск завершён |
| `<chat>` | До `context.channelMessages` последних сообщений текущего канала |
| `<tempo>` | Счётчики за 10 мин / час / сутки, число участников, тишина, вердикт (live / slow / dead) |
| `<task>` | `reply` / `interject` / `initiate` с заполненными плейсхолдерами |

Приоритет бюджета (секции обрезаются с конца этого списка): системный промпт + задача + часы + темп + восприятие
(никогда не обрезаются) → профиль вызвавшего с эпизодами → lookup (сохраняется или отбрасывается целиком) → серверные привычки → факты о себе → лорбук → карта каналов → транскрипт (новейшие сначала) →
остальные профили → соседние каналы.

Медиа в строке транскрипта, наиболее информативная доступная форма: картинка, прикреплённая к ЭТОМУ запросу →
`transcript.imageAttached` (пронумерованы в порядке следования за текстом); описанная →
`imageDescribed` / `gifDescribed` / `videoDescribed`; иначе слепые формы `image` / `gif` / `video`.
Когда зрение видео включено (`features.mediaDescriptions` И `features.videoDescriptions`), видео или ссылка на
видеосайт получает состояние: `videoWatched` (из первых рук, видел и слышал), `videoNotWatchedFrame` (не просмотрено,
но описан стоп-кадр) или `videoNotWatched` (не просмотрено, без кадра). Код причины (`length` / `size` / `daily` /
`error`) заменяется человекочитаемой фразой из `transcript.videoReason.*`, прежде чем попадает в транскрипт. Ссылки
сохраняют свой базовый тег (`link` / `linkText`) и получают видеодополнение: `linkWatched`, `linkNotWatchedFrame` или
`linkNotWatched`. Если стоп-кадр прикреплён как картинка, добавляется также `frameAttached`. Ссылки используют
`link` / `linkText`, построенные из эмбеда Discord (сайт, заголовок, фрагмент); когда `features.webLookup` включён и ссылка была прочитана, `linkRead` добавляется после остальных дополнений ссылки (видео, превью). Текстовые файлы показывают начало через
`filePreview`; пересланное сообщение обёрнуто в `forwarded`.

Результаты просмотра видео кэшируются по вложению или ссылке в `data/guilds/<id>/media.json` под ключом
`video:<itemId>` (id вложения или стабильный хэш URL ссылки). Записи кэша:

- Просмотрено: `{ text, ts, watched: true }`: постоянная, текст описания.
- Непопадание по лимиту (длина или размер): `{ miss: true, ts, reason: "length"|"size" }`: постоянная, файл не изменится.
- Ошибка: `{ miss: true, ts, reason: "error" }`: повторная попытка через `media.video.errorRetryMinutes` (по умолчанию 60) минут или немедленно при принудительной попытке от классификатора повторного просмотра.
- Дневной лимит: не кэшируется; возвращается как `{ state: "limit", reason: "daily" }` только для этого хода.

Ответ повторного просмотра кэшируется под ключом `video:<itemId>:q:<hash>` (первые 16 шестнадцатеричных цифр SHA-1 от приведённого к нижнему регистру и схлопнутого по пробелам вопроса): `{ text, ts, answer: true }`. Истекает через час; код удаляет просроченные записи при чтении.

Запись стоп-кадра картинки хранится под собственным ключом `<itemId>`, как и прежде. Обе могут сосуществовать для одного элемента.

Результаты веб-поиска кэшируются в том же `data/guilds/<id>/media.json` рядом с записями видео и картинок:

- Чтение ссылки: `read:<link.id>` хранит `{ text, ts }` (сжатую выдержку, постоянную) или `{ miss, ts, reason }` (промах, пропускаемый 6 часов; причины: `scheme`, `private`, `redirects`, `type`, `size`, `timeout`, `http`, `network`, `empty`, `unreadable`, `llm`). `TokenLimitError` или `DailyCapError` никогда не кэшируются.
- Поиск: `search:<первые 16 hex-цифр SHA-1 нормализованного запроса>` хранит `{ query, text, sources, ts }`, отдаётся, пока моложе `web.search.cacheHours` (по умолчанию 24). Пустой `text` означает отсутствие результатов (рендерится `labels.lookup.none`). Ошибки не кэшируются.

Строка транскрипта: `#87 [14:32] nick: text <replyTo> <media…> <sticker>`; собственные строки используют `labels.self`; между
строками `labels.transcript.gap` / `gapWithDate` / `date`; блок начинается с `labels.transcript.header`. Соседние
каналы: те же строки без `#n`, под `# channel-name`.

## Метки

Ключи `labels.json`; `{x}` заполняет код.

```
locale                                   BCP-47 tag for dates
ping.prompt                              the whole user message of `/nep ping`; must make any model answer one short word
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}
transcript.gapWithDate                   {duration} {date}
transcript.date | header                 {date}
transcript.empty | replyToOld | image
transcript.replyTo                       {index}
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: appended to a line for a custom emoji; text keeps :name:
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag; the persona re-watched the clip for this question
transcript.videoReason.length | size | daily | error    human phrases for the four reason codes
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config
senses.gifDescribed | gifBlind
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results
lookup.header                            {query}: heading of the `<lookup>` block
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}
profile.affinity                         {score} {band} {reason}
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
triggers.mention | reply | name | followUp   followUp = an untagged message the address classifier judged to be for the persona; such a turn posts plain, never as a Discord reply
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
```

## Вывод

В выводе модели распознаются только эти теги:

- `<think>…</think>` необязателен, первый, 1–4 строки скрытого планирования; незакрытый означает молчание.
- `<msg>text</msg>` одно сообщение в чат, до 3 подряд; `reply="#87"` превращает его в ответ Discord.
- `<react to="#87">💀</react>` один юникодный эмодзи; отдельно или вместе с `<msg>`.
- `<skip/>` промолчать.
- `@nick` в точности как в транскрипте становится реальным упоминанием.

`features.reactions: false` убирает `<react>`, `features.multiMessage: false` оставляет только первый `<msg>`; промптам об этом знать не обязательно.

## Анализатор

Один вызов (`memory.md`) обновляет всё, что персонаж помнит. Он оценивает людей **глазами персонажа**, поэтому получает
карточку персонажа. Жив ли канал, определяет НЕ он; это считает код. Прогрев пропускает старую историю
через свои промпты (`profile.md`, `channel.md`, `server.md`), а не через анализатор.

Числовые лимиты в промпте заполняются в рантайме из `config.memory.*` и `relationships.maxDeltaPerUpdate`.

Вход: `<character>` · `<existing_profiles>` (JSON по user id, включая текущий балл `affinity` с причиной и сохранённые
`episodes`) · `<existing_lore>` ·
`<existing_guild>` (JSON: паттерны, зачины, внутренние шутки, усвоенное) · `<existing_channels>` (JSON по channel id: `name`, категория Discord `category`, `topic`, сохранённые `purpose`,
`topics`, `tone`) · `<new_messages>`, сгруппированные под `## #channel-name (id:123)`, строки `[14:32] nick (id:123): text`,
строка, адресованная персонажу, начинается с `→ `, собственные строки используют `labels.self`.

Выход: голый JSON-объект. Профили обновляются ИНКРЕМЕНТАЛЬНО: анализатор возвращает изменения, а не пересказ
уже сохранённого, поэтому факты не деградируют от переписывания батч за батчом:

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""]
}
```

- **Интересы хранятся атомарно**, не прозой: `topic` (≤ `{{interestTopicChars}}`, идентификатор, сравнивается
  без учёта регистра) и `note` (≤ `{{interestNoteChars}}`, что именно об этом; может быть пустым). Оба плейсхолдера
  заполняются из `memory.interestTopicChars` / `memory.interestNoteChars`, как и остальные лимиты. Хранятся на человека
  до `memory.maxInterestsStored`, каждый с весом, который растёт при повторном добавлении или обновлении; вытесняется
  элемент с наименьшим рангом. На входе показаны сохранённые элементы, чтобы анализатор добавлял только новое, обновлял заметку
  только при новых сведениях и удалял только то, что человек явно забросил.
- **Детали тоже хранятся атомарно**: `{ id, text, weight, firstSeen, lastSeen }`. На входе каждая сохранённая деталь
  показана с числовым `id`; `seen` и `remove` ссылаются на детали по этому id (код также принимает точный сохранённый
  текст). `add` принимает `{ text, sure? }` (допускается и голая строка). Свыше `memory.maxDetailsStored` вытесняется
  элемент с наименьшим рангом.
- **Усвоенное хранится атомарно на уровне сервера**: `{ id, text, from, weight, firstSeen, lastSeen }`. `from` хранит
  участника, который научил (`<@id>`, или пусто). Те же операции `add` / `seen` / `remove`, та же механика подтверждения,
  тот же ранг и вытеснение, что у деталей. `memory.maxLearned` показывается, `memory.maxLearnedStored` хранится,
  `memory.learnedChars` на элемент. Модель чата видит их в `<about_chat>` после строки внутренних шуток, ранжированными,
  неподтверждённые — с `labels.aboutChat.unsureMark`.
- **Подтверждение (механизм «(?)»), общий для интересов, деталей и усвоенного.** `weight` считает отдельные СЛУЧАИ, когда нечто
  было замечено. Новый элемент начинает с веса 1 или 0, если анализатор пометил его `"sure": false` (неясно чьё,
  неясно серьёзно ли, или имя, которое анализатор не распознаёт). `seen` (ничего нового, но тема всплыла снова), `add`
  уже существующего элемента и `update` засчитываются как одно наблюдение; наблюдение увеличивает вес на 1 только если
  сообщения этого человека в батче отстоят от `lastSeen` элемента не менее чем на `memory.confirmGapHours` (один длинный
  разговор, разбитый на несколько батчей, считается один раз). Операция с `"sure": false` на существующем элементе ничего
  не меняет. Элемент считается ПОДТВЕРЖДЁННЫМ при весе ≥ `memory.confirmAfter`; до этого модель чата видит его с
  `labels.profile.unsureMark`.
- **Хранится больше, чем показывается, и ранг убывает со временем.** Код хранит до `memory.maxInterestsStored` /
  `memory.maxDetailsStored` элементов на человека; персонаж И анализатор видят только верхние `memory.maxInterests` /
  `memory.maxDetails` по рангу. Ранг = `log2(weight + 0.5) + lastSeen / halfLife` (периоды полураспада
  `memory.interestHalfLifeDays`, `memory.detailHalfLifeDays`), т. е. вес уменьшается вдвое за каждый период тишины,
  поэтому частое И недавнее наверху, а новичок может набирать вес в невидимом хвосте вместо немедленного вытеснения.
  Вытесняется элемент с наименьшим рангом. Если анализатор добавляет (`add`) то, что уже хранится, но не показано, код
  засчитывает наблюдение; поэтому промпт велит ему добавлять всё, что для НЕГО ново, и не сдерживаться из-за того, что
  список выглядит полным.
- **Даты берутся из сообщений**, а не из часов: `firstSeen` / `lastSeen` это время самого нового сообщения человека в
  батче, породившем наблюдение (min / max, поэтому история, поданная не по порядку, всё равно работает). Интерес, чей
  `lastSeen` старше `memory.interestStaleDays`, показывается модели чата с `labels.profile.staleMark` и сортируется после
  свежих. Детали не устаревают.
- Входное представление сохранённого элемента: интересы `{ topic, note, seen, last }`, детали `{ id, text, seen, last }`
  (`seen` = weight, `last` = `YYYY-MM-DD`, опускается при неизвестном).
- **Атрибуция, для каждого поля профиля.** Факт записывается о человеке только из СОБСТВЕННЫХ сообщений этого человека:
  он поднимает тему, возвращается к ней или говорит о ней предметно. Присутствие в чужой теме или разовый ответ на неё не
  делает её своей. Заметка может содержать только то, что было сказано о ДАННОЙ теме; если неясно, к какой теме или к
  какому человеку относится высказывание, оно отбрасывается или помечается `"sure": false`. То, что делают все на сервере,
  относится к `guild.patterns` или `lore`, а не к каждому профилю.
- **Что представляет каждое прозаическое поле.** `character`: как человек ведёт себя с другими, несколько (4–7)
  конкретных ПОВТОРЯЮЩИХСЯ привычек голосом персонажа («привычки важнее ярлыков»: никаких перечислений прилагательных и
  оценок); навыки, знания, работа, хобби и разовые действия не входят в характер. Сохранённый текст из прилагательных и
  оценок переписывается из батча заново, а не правится по частям. `character`, `relationship`, `reason` отношения и
  `feeling` эпизода пишутся голосом персонажа из карточки (первое лицо допускается, клинической лексики нет). `style`:
  КАК человек пишет (длина, ритм, словарь, привычки с эмодзи), а не что делает или о чём говорит. `relationship`:
  как персонаж и этот человек стоят друг к другу, без новостей и без отношений человека с другими людьми; записывается
  впервые, когда сохранённый текст пуст и батч показывает их реальное взаимодействие (или affinity/episodes уже есть),
  далее только при необходимости изменения. Каждое ≤ `memory.fieldChars`; отсутствующее поле оставляет сохранённый
  текст нетронутым. `character` и `style` пишутся ТОЛЬКО промптом `profile.md` (прогрев и обновление портрета), потоковый
  анализатор их никогда не редактирует напрямую. Анализатор возвращает `portrait` (однострочная подсказка о том, что
  упускает сохранённый текст), когда батч того требует, и код ставит обновление в очередь.
- **Участники указываются по id, никогда по нику.** Ники меняются ежедневно, поэтому во всех текстовых полях, которые
  пишет анализатор (прозаические поля профиля, заметки интересов, текст деталей, `what`/`feeling` эпизодов, причина
  отношения, поля `guild`, заметки каналов, `text` лорбука, `self`), участник записывается как токен `<@id>` (id из
  транскрипта `nick (id:123)` или из `<existing_profiles>`). Только когда анализатор уверен, кто имеется в виду; иначе
  имя остаётся как написано; id никогда не изобретается. Дословные `quote` и лорбучные `keys`/`title` не трогаются. Код
  разрешает токены в момент использования: для модели чата `<@id>` становится текущим именем участника (та же строка, что
  в транскрипте, поэтому `@name` по-прежнему работает), для анализатора он становится `name (id:123)`; на входе код
  превращает `name (id:123)`, написанный моделью, обратно в токен, а неизвестные id оставляет нетронутыми.
- **Псевдонимы** это то, как люди в чате реально называют участника (устоявшееся прозвище вроде сокращённого или
  переведённого имени), НЕ отображаемые имена Discord. `users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`; хранятся
  как ранжированные элементы, аналогично интересам (`memory.maxAliases` показывается, `memory.maxAliasesStored` хранится,
  `memory.aliasHalfLifeDays`), `add` известного псевдонима засчитывается как наблюдение. На входе показываются простым
  списком; модель чата видит их через `labels.profile.aliases` `{text}`. Участник, чьё текущее имя ИЛИ псевдоним
  встречается в недавнем транскрипте, попадает в `<people>`, даже если он не писал; участники, упомянутые в триггере или в
  последних пяти сообщениях (через @упоминание, текущее имя, псевдоним, совпадение начала для имён от 4 символов), идут
  сразу после собеседника полной записью (не более `context.askedAboutProfiles`), остальные недавние участники после них в
  компактной форме (имя, псевдонимы, характер, отношение, топ-5 тем); бюджет обрезает компактные записи первыми.
- **Основные каналы как источник портрета.** `memory.mainChannelIds` (по умолчанию `[]`) перечисляет каналы, где люди
  общаются друг с другом; в `<existing_channels>` такой канал несёт `"main": true` (ключ опущен в остальных случаях).
  `character` и `style` оцениваются по тому, как человек говорит с другими в основном канале; дневники и тематические
  каналы питают интересы и детали, но не манеру речи. Пока у человека нет сообщений в основных каналах, портрет остаётся
  предварительным и коротким. В батче с сообщениями человека из основных каналов обновление портрета УТОЧНЯЕТ оба поля:
  возвращает полный новый текст (≤ `memory.fieldChars`), сохраняя то, что ещё верно, добавляя то, что показал батч,
  позволяя свежим свидетельствам перевешивать старые и убирая то, что больше не проявляется, чтобы портрет следовал за
  человеком на протяжении лет. Когда ни один канал не отмечен как основной, все каналы считаются основными.
- **Серверные заметки о сервере.** То, что один человек делает в своём канале, не является серверным паттерном, зачином
  разговора или внутренней шуткой и не является записью `lore`; внутренняя шутка это то, чем пользуются несколько человек.
- **Лимиты мягкие для модели, строгие в коде.** Промпт называет лимит L (плейсхолдеры, включая `{{loreTextChars}}` из
  `lore.textChars`); код принимает до `L * memory.clampTolerance` (по умолчанию 1.25), а дальше обрезает на границе
  последнего предложения или слова, никогда внутри токена `<@id>`, и убирает повисшие открывающие скобки и конечные
  разделители. Сохранённая заметка или текст, видимо оборванные на середине слова (обрезка старой версией), целиком
  переписываются при следующем появлении их темы.
- **Экономия выхода.** `"sure"` записывается только при значении false; `affinity` опускается, когда ничего не изменилось.
- **Один дом для каждого факта.** Событие идёт в `episodes` или `lore`, факт в `details`, увлечение в `interests`,
  урок, адресованный персонажу, в `learned`; одно и то же никогда не записывается в несколько полей.
- **Проверка по знаниям модели.** Прежде чем привязать одну сущность к другой (регион, режим, персонаж или предмет к
  игре; человека к франшизе), анализатор проверяет, что они связаны. Если формулировка чата противоречит его знаниям или
  он не узнаёт сущность, он не склеивает: записывает сущность отдельно с `"sure": false`. Он никогда не «исправляет» чат.
- **Заметка говорит, что человек делает с темой** (играет, смотрит видео, лишь упомянул), и то, чем человек занимался
  давно и бросил, не является интересом (в лучшем случае деталь). То, что невозможно понять вне контекста разговора, не
  записывается.
- Намеренно отсутствует: любое правило об иронии или сарказме. Неопределённость любого рода проходит через `"sure": false`.
- Промпт анализатора остаётся коротким; каждое добавленное правило оплачивается ужесточением существующего текста.
- Только пользователи и каналы, у которых есть что-то новое. Возвращённый канал / `guild` / `self` является ЦЕЛЫМ
  объединённым значением и заменяет сохранённое; пустой `guild` / `self` = ничего нового.
- `affinity` это ИЗМЕНЕНИЕ: целочисленный `delta` (обычно ±1…5, до ±`relationships.maxDeltaPerUpdate` за что-то
  значительное), однострочный `reason` с описанием наблюдённого события. Код ограничивает его до
  ±`relationships.maxDeltaPerUpdate`, накапливает в диапазоне −100…100, ведёт краткую историю. Модель никогда не задаёт
  абсолютный балл.
- `episodes` ДОПОЛНЯЮТСЯ, никогда не переписываются: возвращаются только НОВЫЕ моменты, достойные запоминания на месяцы:
  оскорбление, доброта, обещание, пари, ссора, общая шутка, просьба что-то сделать или никогда не делать. `what` одна
  строка; `quote` дословные слова человека, короткие (≤ 120 символов), или пустое; `feeling` как персонаж это воспринял,
  судя по карточке персонажа; `weight` 1–5 (5 = никогда не забывать). Не более `memory.maxNewEpisodes` на пользователя за
  батч; большинство батчей не добавляют ни одного. На входе показаны уже сохранённые эпизоды, чтобы ничего не записывалось
  дважды. Код хранит `memory.maxEpisodes` на человека, вытесняя сначала самые лёгкие, затем самые старые.
- `lore` это серверный лорбук: то, что переживает любой разговор: события («день, когда X ушёл»), повторяющиеся персонажи
  и питомцы, длительные истории, конфликты, традиции. `title` является идентификатором (запись с тем же заголовком это
  ОБНОВЛЕНИЕ, несущее полный объединённый текст), `keys` 2–6 слов или коротких фраз, которые люди реально набирают, когда
  тема всплывает (имена, прозвища, формулировка мема, на языке чата, строчными буквами), `text` ≤ `lore.textChars`
  (`{{loreTextChars}}`). Вход `<existing_lore>` перечисляет сохранённые заголовки с ключевыми словами и полный текст
  записей, которые батч затрагивает. Записи, добавленные владельцем (`/nep lore add`), анализатор никогда не меняет.
- Текстовые поля ≤ `memory.fieldChars`; детали ≤ `memory.maxDetails`, внутренние шутки ≤ `memory.maxInjokes`,
  self ≤ `memory.maxSelfFacts`. Заметки на языке чата. Только наблюдаемые факты; ничего чувствительного (адреса, телефоны,
  документы, здоровье, финансы, полные настоящие имена).

## Карта каналов

Блок `<server>` собирается из сохранённых заметок каналов и фактов, которые ведёт код, и фильтруется до каналов, важных
для этого хода. Текущий канал показывается первым, отмечен `labels.server.currentMark`; затем только те соседние каналы,
которые дали сообщения в `<other_channels>` этого хода, каждый полностью. Все остальные сохранённые каналы опускаются. На
большом сервере большинство из них неактуальны и тратят бюджет.

Запись канала (`renderChannel` в `src/memory/channels.js`) содержит:

- **Факты Discord:** имя (заголовок `#`), категория, тема. Присутствуют с момента первого обнаружения канала.
- **Заметки анализатора:** назначение, темы, тон. Записываются промптом `channel.md` при прогреве и обновляются
  потоковым анализатором (`memory.md`) из живых батчей. Все три поля текстовые, с подстановкой токенов (`<@id>` →
  текущее имя) при рендеринге.
- **Счётчики, которые ведёт код:** количество сообщений, время первого и последнего сообщения, гистограмма активности за
  30 дней (сообщений за сутки UTC, урезанная до 30 последних дней) и топ-5 авторов (по количеству сообщений, без ботов и
  персонажа). Прогрев заполняет их из загруженной истории канала через `store.setChannelFacts`; живой трафик поддерживает
  актуальность через `store.touchChannel`.
- **Вердикт активности:** `live`, `slow` или `dead`, вычисляется `channelActivity` из счётчиков, модель не определяет.
  `live`, когда сумма сообщений за сегодня и вчера (UTC) достигает `context.channelActivity.liveMessagesPerDay` (по
  умолчанию 20). `dead`, когда в канале ни одного сообщения или последнее старше
  `context.channelActivity.deadAfterDays` (по умолчанию 7). `slow` покрывает всё остальное. Рендерится через
  `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead`.
- **Давность последнего сообщения:** форматируется через `labels.server.lastMessage`, когда метка существует и данные
  доступны.
- **Самые активные авторы:** рендерятся через `labels.server.topWriters`, id сохранённых авторов подставляются текущими
  именами; id без профиля пропускается.

Когда у текущего канала ещё нет сохранённой заметки (анализатор его не обрабатывал), запись-заглушка синтезируется из
фактов Discord по сообщениям в транскрипте, чтобы персонаж всё же знал, где находится.

## Прогрев

Каждый запрос прогрева обрабатывает одну единицу работы (один канал, одного человека или сервер), чтобы атрибуция
оставалась чистой. `channel.md` создаёт заметки канала (назначение, темы, тон). `profile.md` создаёт характер, стиль,
интересы, детали, эпизоды и псевдонимы участника. `server.md` создаёт серверные паттерны, зачины разговоров, внутренние
шутки и записи лорбука. Порядок прогона, выборка, прогресс, ограничения и подкоманды описаны в разделе
[Прогрев](warmup.md).

### Модель данных

`character` и `style` ОСТАЮТСЯ ПРОЗОЙ и пишутся ТОЛЬКО промптом `profile.md`: при прогреве и при ОБНОВЛЕНИИ ПОРТРЕТА.
Потоковый анализатор их никогда не редактирует: для участника, чей батч показал повторяющуюся привычку или изменение в
манере письма, которые сохранённый портрет упускает или которым противоречит, он возвращает
`users.<id>.portrait: "one line: what the portrait misses"`. Код ставит обновление этого участника в очередь: `profile.md`
вызывается с `<draft>` = сохранённые характер + стиль, `<hint>` = строка анализатора, и `character` + `style` из ответа
заменяют сохранённые (интересы, детали, эпизоды и псевдонимы этого ответа ИГНОРИРУЮТСЯ; они продолжают поступать через
инкрементальные операции потокового анализатора).

Отношение и `relationship` НЕ прогреваются; они растут только из живого общения.

Выход `profile.md`: `{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`; блоки `<character>` `<member>` `<draft>` (необязателен) `<hint>` (необязателен,
только обновление портрета) `<snippets>`. Собственные строки в выборке начинаются с `labels.warmup.ownMark`; строки
контекста начинаются с `labels.warmup.contextMark`. Псевдонимы берутся из строк ДРУГИХ людей (как они обращаются к
участнику), поэтому правило атрибуции по собственным строкам к ним не применяется.

## Классификатор обращений

После того как персонаж ответил кому-то, в этом канале открывается окно разговора (`mention.followUpMinutes`, продлевается
каждым следующим ответом). Сообщение внутри окна, не содержащее триггера (ни упоминания, ни ответа персонажу, ни имени), не
получает ответ вслепую: код отправляет последние `mention.followUpContext` (по умолчанию 15) строк канала, собственные
строки персонажа отмечены `labels.self`, плюс новое сообщение, отмеченное как `<candidate>`, в `address.md` на роли модели
`classifier.text` (по умолчанию `anthropic/claude-sonnet-4.6`). Выход: ОДНА строка: `yes`, когда кандидат адресован
персонажу или продолжает обмен с ним, `no`, когда люди говорят между собой или с кем-то другим (ответ другому участнику
или упоминание другого участника всегда `no` до обращения к модели). `yes` запускает обычный ход ответа (модель всё ещё
может ответить `<skip/>`); три `no` подряд (`mention.followUpNoStreak`, по умолчанию 3) закрывают окно. Переключатель
`features.followUp` (по умолчанию включён). Логируются только счётчики и вердикты.
Состояние окна переживает перезапуск: активные окна сохраняются в `data/state.json` под ключом `followUpWindows` и восстанавливаются при запуске, истёкшие удаляются.

## Классификатор пересмотра

Когда к персонажу обращаются (ход ответа) и в последних `media.video.rewatch.recentMessages` (по умолчанию 60)
сообщениях канала есть видео, классификатор определяет, спрашивает ли сообщение об одном из этих видео или просит
повторить загрузку незагрузившегося. Кандидаты: просмотренные видео и видео с ошибкой (запрошенная повторная загрузка использует собственный слот,
независимый от попыток `media.video.maxPerTurn` хода). Классификатору предлагается не более
`media.video.rewatch.maxCandidates` (по умолчанию 6) видео, от новейшего к старейшему. Код отправляет `rewatch.md`
как системный промпт на роли модели `classifier.text` (по умолчанию `anthropic/claude-sonnet-4.6`) с
пользовательским сообщением, содержащим три блока: короткий `<transcript>` из последних
сообщений канала, собственные строки персонажа отмечены `labels.self` (чтобы классификатор видел, на что отвечает
кандидат), затем список видео и кандидат:

```
<transcript>
...
</transcript>
<videos>
<number> | <name> | <status> | <начало описания>
...
</videos>
<candidate>
<имя автора>: <текст триггера>
</candidate>
```

Каждая строка `<videos>` содержит четыре столбца через `|`: порядковый номер (1 = самое новое видео), название
видео, статус (`watched` или `not loaded`) и первые 200 символов описания (пусто для незагрузившихся видео).
Названия и описания схлопнуты по пробелам в одну строку. Текст триггера обрезан до `context.maxMessageChars`.
Выход: ОДНА строка:

- `<number> | <question>`: сообщение спрашивает о просмотренном видео и требует деталь, не покрытую описанием. Номер копируется из списка.
- `<number> | retry`: сообщение о незагрузившемся видео и просит попробовать снова или спрашивает о его содержимом. Номер копируется из списка.
- `none`: второй просмотр или повтор загрузки не нужны.

При попадании с вопросом видеомодель смотрит клип ещё раз с `rewatch-answer.md` (`{{question}}` и `{{maxChars}}` =
`rewatch.answerChars`, по умолчанию 1200), и ответ добавляется в транскрипт как `transcript.videoAnswered`
(`{question}`, `{text}`) после тега просмотра. Блок `<senses>` включает `senses.videoRewatch`, когда функция
включена.

При попадании с retry видеомодель смотрит клип с `force` (игнорируя кэш ошибки), по тому же пути `describeVideo`,
что и первый просмотр. Если попытка удалась, состояние видео меняется с ошибки на просмотренное, и транскрипт
показывает описание как из первых рук. Повтор загрузки считается новой попыткой против `media.video.maxPerTurn` и
`media.video.maxPerDay`.

Ограничения: не более одного повторного просмотра или повтора загрузки за ход; классификатор и повторный просмотр
каждый считаются в `llm.maxRequestsPerDay`; повторный просмотр также считается в `media.video.maxPerDay`;
`media.video.rewatch.maxPerDay` (по умолчанию 20) ограничивает повторные просмотры отдельно. Ответы кэшируются на час
по каждому вопросу (см. раздел кэша видео выше). Переключатель `features.videoRewatch` (отсутствие = включён,
требуется `videoDescriptions`).

## Классификатор поиска

Когда к персонажу обращаются (ход ответа) и выполнены все условия (`features.webLookup` включён, `web.search.enabled`
не false, промпт `lookup.md` существует, `web.search.maxPerTurn` не менее 1 и `BRAVE_SEARCH_API_KEY` настроен),
классификатор определяет, спрашивает ли триггерное сообщение о чём-то, что требует поиска в интернете. Он использует
роль модели `classifier.text`. Код отправляет `lookup.md` как системный промпт с пользовательским сообщением,
содержащим короткий `<transcript>` (тот же, что у классификатора повторного просмотра, собственные строки персонажа
отмечены `labels.self`) и блок `<candidate>`:

```
<transcript>
...
</transcript>
<candidate>
<имя автора>: <текст триггера>
</candidate>
```

Транскрипт содержит описания, описания видео и прочитанные ссылки, если доступны. Текст триггера обрезан до
`context.maxMessageChars`. Выход: ОДНА строка:

- Поисковый запрос (обычные слова, без кавычек, без операторов, не более 12 слов), когда сообщение требует фактов
  извне чата.
- `none` во всех остальных случаях.

При совпадении Brave Search выполняет запрос (`web.search.results` результатов, по умолчанию 5), нумерованные
результаты сжимаются ролью `classifier.text` через `search-summary.md` (`{{query}}`, `{{maxChars}}` =
`web.search.summaryChars`, по умолчанию 900), и ответ рендерится в блок `<lookup>` непосредственно перед `<chat>`:
`labels.lookup.header` с запросом, сжатый текст и `labels.lookup.sources` с именами сайтов. Если поиск ничего не вернул
или конденсатор не нашёл полезного, вместо этого появляется `labels.lookup.none`.

Ограничения: не более одного поиска за ход; и классификатор, и конденсатор считаются в `llm.maxRequestsPerDay`;
сам поиск считается в `web.maxPerDay` (общий с чтением ссылок). Результаты кэшируются на
`web.search.cacheHours` (по умолчанию 24) часов на нормализованный запрос. Переключатель `features.webLookup`
(отсутствие = выключен).
