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
| `describe.md` | да | Внеролевой промпт модели описаний медиа (`features.mediaDescriptions`): одна картинка на входе, одна строка на выходе: действие и суть, читаемый текст цитируется в оригинальном написании. Всегда на английском. Без комментариев, без морализаторства, без разметки | `{{today}}` `{{maxChars}}` (необязательный) |
| `describe-video.md` | да | Внеролевой промпт модели описаний видео (`features.videoDescriptions`): один видеоклип на входе (со звуком), полное описание настраиваемой длины на выходе: кто появляется, что говорится (ключевые фразы цитатой), текст на экране, что происходит визуально, музыка/звук при необходимости. Всегда на английском; речь, субтитры и текст на экране цитируются на языке оригинала. Без карточки персонажа | `{{today}}` `{{maxChars}}` |
| `rewatch.md` | да | Классификатор: нужно ли персонажу пересмотреть видео или повторить загрузку незагрузившегося (`features.videoRewatch`). Получает нумерованный список недавних видео с их статусом и новое сообщение. Выход: ОДНА строка: `<number> \| <question>`, `<number> \| retry` или `none` | `{{name}}` |
| `rewatch-answer.md` | да | Внеролевой промпт для повторного просмотра: видеомодель смотрит клип ещё раз и отвечает на один вопрос на языке вопроса. Без карточки персонажа | `{{today}}` `{{question}}` `{{maxChars}}` |
| `address.md` | да | Классификатор: адресовано ли сообщение без обращения персонажу | `{{name}}` |
| `lookup.md` | нет | Классификатор: нужно ли персонажу искать в интернете, чтобы ответить на сообщение (`features.webLookup`). Получает короткий транскрипт и блок `<candidate>`. Выход: ОДНА строка: поисковый запрос (обычные слова, не более 12) или `none` | `{{name}}` |
| `read-link.md` | нет | Внеролевой промпт для чтения ссылок (`features.webLookup`, `web.links.enabled`): сжать загруженную страницу в один абзац. Получает заголовок и тело страницы. Без карточки персонажа | `{{maxChars}}` |
| `search-summary.md` | нет | Внеролевой промпт для конденсатора поиска (`features.webLookup`, `web.search.enabled`): сжать нумерованные результаты поиска в одну заметку со встроенными ссылками на источники. Без карточки персонажа | `{{query}}` `{{maxChars}}` |
| `private.md` | нет | Добавляется после промпта режима (`reply.md`), перед `forced.md`, только в личном сообщении (`features.privateMessages`). Приватный разговор: сказанное здесь остаётся здесь; персонаж сохраняет публичные знания. Отсутствующий файл ничего не добавляет | `{{name}}` `{{author}}` |
| `draw.md` | да | Внеролевой промпт подпроцесса рисования (`features.imageGeneration`): создаёт одну картинку по описанию сцены. Получает только внешность и запрос — никогда карточку персонажа | `{{name}}` `{{appearance}}` `{{request}}` |
| `appearance.md` | нет | Внешний вид персонажа, вставляется в `draw.md` при `self="yes"`. Один абзац, без личности, без предыстории | `{{name}}` |
| `mentor-situations.md` | нет | Ментор: придумать тестовые ситуации для кейса reply (`features.mentor`). Возвращает только JSON | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-situations-memory.md` | нет | Ментор: придумать тестовые ситуации для кейса memory (`features.mentor`). Возвращает только JSON | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | нет | Ментор: оценить ответы персонажа на ситуацию (`features.mentor`). Получает карточку персонажа. Возвращает только JSON | `{{name}}` |
| `mentor-score-memory.md` | нет | Ментор: оценить текст, который записал бы анализатор (`features.mentor`). Без карточки персонажа. Ось `character` всегда `null`. Возвращает только JSON | `{{name}}` |
| `mentor-signs.md` | нет | Ментор: известные привычки модельного текста, отправляется как блок `<signs>` в каждом запросе ментора (`features.mentor`). Опускается при отсутствии или пустом файле | `{{name}}` |
| `mentor-diagnose.md` | нет | Ментор: объяснить слабые ответы после оценки, указывая на конкретный текст в контексте персонажа (`features.mentor`). Результат — непроверенная гипотеза, сохраняется как `diagnosis` в прогоне. Опускается при `mentor.diagnose` false или отсутствии файла | `{{name}}` |
| `mentor-fix.md` | нет | Исправление ментора: написать одну правку по подтверждённой причине (`features.mentorAutoFix`). Получает подтверждённого подозреваемого, вердикт и полный запрос, который видел персонаж. Возвращает JSON-правку. Опускается при отсутствии файла | `{{name}}` |
| `labels.json` | да | Все строки, которые КОД вставляет в промпт. Ключи фиксированы ниже, формулировки определяет автор текстов | см. ниже |

`{{name}}` отображаемое имя бота · `{{author}}` отображаемое имя вызвавшего · `{{trigger}}` одно из значений `labels.triggers.*` ·
`{{target}}` индекс вызвавшего сообщения (`#87`).
Системное сообщение = `system-prompt` + `character-card` + `rules` + `format`. Для анализатора: только `memory.md`.
При принудительном ходе (`/nep interject`, `/nep initiate`) `forced.md` добавляется после промпта режима, если файл существует.
В приватном чате `private.md` добавляется после промпта режима (перед `forced.md`) с теми же плейсхолдерами `{{name}}` и `{{author}}`.
Анализатор и промпты прогрева `profile.md` и `server.md` получают карточку персонажа и `rules.md` как блок
`<character>` в пользовательском сообщении. `channel.md`, `describe.md`, `describe-video.md`, `draw.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md` и `search-summary.md` карточку не получают.

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
`transcript.imageAttached`, или `transcript.imageAttachedDescribed`, когда `features.attachedDescriptions` включён и
помощник дал подпись (пронумерованы в порядке следования за текстом); описанная →
`imageDescribed` / `gifDescribed` / `videoDescribed`; иначе слепые формы `image` / `gif` / `video`.
Когда зрение видео включено (`features.mediaDescriptions` И `features.videoDescriptions`), видео или ссылка на
видеосайт получает состояние: `videoWatched` (из первых рук, видел и слышал), `videoNotWatchedFrame` (не просмотрено,
но описан стоп-кадр) или `videoNotWatched` (не просмотрено, без кадра). Код причины (`length` / `size` / `daily` /
`error`) заменяется человекочитаемой фразой из `transcript.videoReason.*`, прежде чем попадает в транскрипт. Ссылки
сохраняют свой базовый тег (`link` / `linkText`) и получают видеодополнение: `linkWatched`, `linkNotWatchedFrame` или
`linkNotWatched`. Если стоп-кадр прикреплён как картинка, добавляется также `frameAttached`. Ссылки используют
`link` / `linkText`, построенные из эмбеда Discord (сайт, заголовок, фрагмент); когда `features.webLookup` включён и ссылка была прочитана, `linkRead` добавляется после остальных дополнений ссылки (видео, превью). Текстовые файлы показывают начало через
`filePreview`; пересланное сообщение обёрнуто в `forwarded`. Когда `features.seeReactions` включён (по
умолчанию), тег реакций добавляется в самый конец строки, после медиатегов и пересланных сообщений. Он содержит не
более `context.reactionsPerMessage` реакций на сообщение, самые частые первыми; каждый элемент использует
`transcript.reactionItem` или `transcript.reactionMine` (когда персонаж среди поставивших реакцию), соединённые
через ", " и обёрнутые в `transcript.reactions`. Файл меток без `transcript.reactions` ничего не рендерит.

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

Строка транскрипта: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`; собственные строки используют `labels.self`; между
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
transcript.imageAttachedDescribed        {n} {text}: attached to the request and captioned by the helper (features.attachedDescriptions)
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
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config. imageSee also covers the helper's note when features.attachedDescriptions is on
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
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona it can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows it has private chats and never repeats or hints at anything from them
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
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
mentor.intended                          array of short strings: engine behaviours that must not cost points in the mentor's scoring
mentor.examples                          first line inside the `<examples>` block in a situations request: introduces the real moments
mentor.original                          first line inside the `<original>` block in a score request: introduces the persona's rejected answer
```

## Вывод

В выводе модели распознаются только эти теги:

- `<think>…</think>` необязателен, первый, 1–4 строки скрытого планирования; незакрытый означает молчание.
- `<msg>text</msg>` одно сообщение в чат, до 3 подряд; `reply="#87"` превращает его в ответ Discord.
- `<react to="#87">💀</react>` один юникодный эмодзи; отдельно или вместе с `<msg>`.
- `<draw self="yes" reply="#87">scene</draw>` картинка для подпроцесса рисования. Один на ход, первый непустой побеждает, обрезается до 800 символов. `self="yes"` добавляет внешность персонажа; `reply="#87"` работает как на `<msg>`. Может быть вместе с `<msg>` и `<react>`.
- `<skip/>` промолчать.
- `@nick` в точности как в транскрипте становится реальным упоминанием.

`features.reactions: false` убирает `<react>`, `features.multiMessage: false` оставляет только первый `<msg>`;
`features.imageGeneration: false` или отсутствие клиента изображений убирает `<draw>`; на ходе `drawFailed` тег `<draw>` тоже убирается. Промптам об этом знать не обязательно.

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

## Рисование

Персонаж может создавать картинки через подпроцесс рисования (`features.imageGeneration`, включён по умолчанию). Когда
модель выдаёт тег `<draw>`, `src/behavior/turn.js` собирает промпт изображения из `draw.md` и генерирует одну картинку
через OpenRouter Images API (`src/llm/images.js`). Картинка публикуется отдельным сообщением после текстовых сообщений
персонажа, никогда не встраивается.

### Сборка промпта

`buildDrawPrompt` (`src/behavior/prompt.js`) заполняет `draw.md` тремя плейсхолдерами:

- `{{name}}` — отображаемое имя бота.
- `{{appearance}}` — `appearance.md` с заполненным `{{name}}`, включается только при `self="yes"`. Иначе пусто.
- `{{request}}` — текст сцены из тега `<draw>`, обрезанный до `image.maxPromptChars` (по умолчанию 800).

Подпроцесс рисования никогда не получает карточку персонажа, `rules.md` или системный промпт. Он следует собственному
разделу стиля внутри `draw.md`.

### Референс

Когда персонаж изображён на картинке (`self="yes"`) и `image.reference` равен `'avatar'` (по умолчанию), аватар бота из
Discord загружается и отправляется как элемент `input_references`, чтобы модель изображений видела, как выглядит персонаж.
Если аватар не удаётся загрузить, генерация продолжается без референса.

### Восприятие

Блок `<senses>` включает одну строку о рисовании, когда клиент изображений подключён и `features.imageGeneration` не false:

- `senses.draw` — персонаж может рисовать.
- `senses.drawSpent` — дневная квота (`image.maxPerDay`) исчерпана.
- `senses.drawSpentUser` — дневная квота этого участника (`image.maxPerUserPerDay`) исчерпана.

Старый `labels.json` без `senses.draw` ничего не покажет.

### Ход при ошибке

Когда генерация не удалась на ходе ответа (кто-то просил картинку), автоматически запускается второй ход:

- `triggerKind: 'drawFailed'`, с причиной ошибки через `labels.draw.reasons.*` в плейсхолдер `{reason}` метки
  `labels.triggers.drawFailed`.
- Режим `reply`, то же триггерное сообщение, ответы разрешены.
- Собственный `<draw>` второго хода убирается, поэтому модель не может повторить генерацию.
- Уведомление о простое канала откладывается до завершения второго хода, поэтому отложенный пинг обрабатывается только
  после продолжения.

На спонтанном ходе (никто не просил) неудачная генерация только логируется, второй ход не запускается.

Превышение лимита картинок (`ImageCapError`, причина `daily` или `userDaily`) НЕ запускает ход при ошибке. Вместо этого
ход публикует уведомление о лимите (`labels.limits.notice`) как обычный ответ. Строка восприятия уже сообщила персонажу,
что квота исчерпана; уведомление сообщает просившему, какой лимит и числа. `draw.reasons.daily` и `draw.reasons.userDaily`
зарезервированы в `labels.json`, но больше не достигаются через `triggers.drawFailed`.

### Ограничения

- Один `<draw>` на ход; первый непустой побеждает, обрезается до `image.maxPromptChars` (по умолчанию 800).
- `image.maxPerDay` (по умолчанию 50) и `image.maxPerUserPerDay` (по умолчанию 50) проверяются и считаются до отправки
  запроса; превышение выбрасывает `ImageCapError` с причиной `daily` или `userDaily`.
- Неподдерживаемое семейство моделей (не `openai/*` и не `google/*`) отклоняется с `UnsupportedImageModelError`.
- Ошибки генерации выбрасывают `ImageGenError` с причиной `moderation`, `timeout`, `error` или `empty`.
- Транзиентные HTTP-ошибки (408, 429, 5xx) и сетевые сбои повторяются до `image.retries` (по умолчанию 1) раз.
- Отклонения модерацией (HTTP 400/403 с маркером модерации) не повторяются.
- Логи содержат модель, счётчики, стоимость и причины ошибок — никогда промпт, потому что он может цитировать участников.
- В сухом прогоне полный промпт изображения (файлы промптов + запрос персонажа) логируется и зеркалируется, но ничего не
  генерируется.

## Приватный чат

`features.privateMessages` (выключен по умолчанию) позволяет участникам обслуживаемого сервера писать персонажу в личные
сообщения Discord. Персонаж остаётся тем же с той же публичной памятью; сказанное в ЛС хранится в приватном слое для
каждого участника, невидимом другим разговорам.

### Шлюз

ЛС получает ответ, когда ВСЕ условия выполнены (проверяется локально, без токенов):

1. `features.privateMessages` равен `true`.
2. Автор является участником обслуживаемого сервера.
3. У персонажа есть сохранённый публичный профиль автора.
4. Публичный `affinity.score >= private.minAffinity` (по умолчанию 5). Владельцы бота обходят эту проверку.
5. Сегодняшнее количество ответов не превышает лимит (`private.maxPerOwnerPerDay` для владельцев,
   `private.maxPerUserPerDay` для остальных).

Всё, что не проходит, отбрасывается молча, кроме шага 5: при достижении дневного лимита бот публикует уведомление
(`labels.limits.notice` с ключом конфигурации) раз в день на человека.

### Что содержит и что опускает ход в ЛС

- Блок `<server>` (карта каналов) и `<other_channels>` опускаются.
- `prompts.private` (если существует) добавляется после промпта режима (`reply.md`), перед `forced.md`, с заполненными
  `{{name}}` и `{{author}}`.
- `{{trigger}}` берётся из `labels.triggers.private`.
- `<senses>` содержит `senses.privateChat`.
- На серверном ходе, когда `features.privateMessages` включён, `<senses>` содержит `senses.privateAware` (правило
  о неразглашении приватного).
- Профиль собеседника строится как `mergeProfiles(publicProfile, privateProfile)` из `src/behavior/private.js`.
  Остальные профили (`askedAbout`, участники) остаются только публичными.
- Без шанса игнорирования, без окна follow-up, без подслушивания, без классификатора обращений.
- Правило одного внимания действует: ЛС, пришедшее, пока персонаж занят, откладывается как отложенный пинг.

### Приватный слой

`data/guilds/<guildId>/private/<userId>.json` хранит то, что персонаж узнал от участника в ЛС. Содержит собственные
`relationship`, `interests`, `details`, `episodes` и `affinity` (начальный балл 0). Никогда не показывается другим
разговорам, никогда не записывается серверным батчем, никогда не смешивается с публичным профилем на диске.

В ЛС персонаж видит публичные и приватные данные объединёнными (только для отображения): интересы объединяются по теме
(приватная заметка побеждает), детали конкатенируются, эпизоды сортируются по дате, тексты `relationship` соединяются.

### Отношение в ЛС

Публичный балл меняется только от серверных батчей. Приватный слой имеет собственный балл, начинающийся с 0, изменяемый
только батчами ЛС. В ЛС персонаж ощущает `clamp(публичный + приватный, -100, 100)`; на сервере — только публичный.
Шлюз использует только публичный балл.

### Анализатор в приватном режиме

`analyzePrivate` строит запрос `memory.md` с тем же форматом и блоком `<private>` (`labels.memory.privateNote`).
`<existing_profiles>` содержит ТОЛЬКО партнёра, отрендеренного как приватный профиль (приватные детали с id, приватные
интересы, приватные эпизоды, эффективное отношение). `<public_profile>` показывает публичный профиль партнёра (только
для чтения). `<existing_guild>`, `<existing_lore>` как обычно (только для чтения). `<new_messages>` озаглавлены
`labels.memory.privateChannel`.

Из ответа применяется только `users[<partnerId>]` через методы приватного хранилища. `portrait` и `aliases`
игнорируются. `guild`, `channels`, `lore`, `self` и другие id отбрасываются и логируются как счётчики.

## Ментор

Ручной подпроцесс (`features.mentor`) со своей моделью (`mentor.model`). Владелец добавляет кейс (желаемое поведение персонажа), ментор придумывает чат-ситуации, прогоняет через них персонажа в песочнице и оценивает ответы. При включённом `features.mentorAutoFix` проваленный прогон продолжается циклом исправления: абляция, правка, верификация. Один прогон за раз. Вся работа остаётся в `data/`; при установленном `bot.dryRunChannelId` завершённый прогон публикуется и туда. Без канала администратора владелец следит за прогоном через `/nep mentor status` и читает отчёт через `/nep mentor show <id>`.

### Приватность

Модель ментора читает отрендеренный запрос песочницы, а значит читает, что персонаж помнит о реальных людях. Личные сообщения и приватный слой памяти никогда не попадают в запрос песочницы.

### Как завершается прогон

Прогон завершается нормально с вердиктом и отчётом. Он может также завершиться досрочно:

- **Остановлен** (`budget`): дневной бюджет токенов исчерпан. Переключатели и бюджет проверяются перед каждой ситуацией и перед каждым запросом ментора.
- **Остановлен** (`owner`): владелец выполнил `/nep mentor stop` или `/nep pause`.
- **Остановлен** (`disabled`): `features.mentor` или `mentor.model` были отключены во время прогона.
- **Ошибка** (`the reference is empty`): ни одного сообщения людей не удалось прочитать из каналов эталона в окне эталона. Прогон завершается до первого запроса к модели.

Остановленный прогон сохраняет уже полученные баллы и включает их в отчёт.

### Реальные моменты (anchors)

Кейс может содержать реальные моменты из чата. Каждый момент — одно сообщение персонажа, которое владелец отклонил. Разрешение: бот загружает сообщение, находит триггер (сообщение, на которое оно отвечает, либо последнее сообщение перед ним, не принадлежащее персонажу), собирает до `mentor.anchor.contextMessages` (по умолчанию 30) сообщений этого канала, заканчивая триггером, и сохраняет весь всплеск персонажа (последовательные сообщения от указанного) как оригинальный ответ. Сохранённая история нормализуется так же, как обычный транскрипт (метки медиа, реакции), но ничего не скачивается. Имена и реакции остаются такими, какими были в момент загрузки. После сохранения момент воспроизводится из сохранённых сообщений, даже если канал двигается дальше или сообщение удаляется.

Кейс хранит моменты как `anchors`:

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...", "history": [/* нормализованные сообщения */], "original": ["text", "..."] }]
```

В прогоне каждый воспроизводимый anchor становится отдельной ситуацией, пронумерованной перед придуманными. Запись ситуации несёт `anchor: <id>` (отсутствует у придуманных). Воспроизведение использует сохранённую историю в момент времени оригинального ответа персонажа, в канале этого anchor.

В запросе ситуаций anchors кейса показываются модели ментора как `<examples>` (последний блок). Каждый `<example>` содержит `<situation>` с сохранённым транскриптом и `<original>` с сообщениями персонажа. Самые старые сообщения каждого примера могут быть обрезаны, чтобы блок уместился в бюджет запроса; триггер не удаляется. Ментор придумывает ситуации того же рода: соответствующую длину сообщений, число ходов и давление.

В запросе оценки реального момента `<original>` появляется между `<situation>` и `<answers>`, содержа отклонённый ответ персонажа как заведомо плохой эталон.

Лимит валидатора на одну строку придуманной ситуации — 2000 символов (вместо прежних 500), чтобы ментор мог соответствовать длине сообщений в примерах.

Диагностика предпочитает реальный момент как `<worst>`, если таковой есть среди слабых ситуаций.

### Промпты

Ментор использует шесть файлов промптов: по паре на каждую цель, файл признаков и файл диагностики:

- **Цель reply**: `mentor-situations.md` (придумать ситуации) и `mentor-score.md` (оценить ответы).
- **Цель memory**: `mentor-situations-memory.md` (придумать ситуации) и `mentor-score-memory.md` (оценить сохранённый текст).
- **Диагностика**: `mentor-diagnose.md` (объяснить слабые ответы после оценки).

Каждый файл — системное сообщение одного запроса ментора. Блоки приходят в пользовательском сообщении.

Плейсхолдеры, заполняемые кодом: `{{name}}` во всех шести; `{{count}}`, `{{minLines}}`, `{{maxLines}}` в двух промптах ситуаций.

### Блоки

| Блок | Содержимое | В каком запросе |
|---|---|---|
| `<case>` | Текст кейса владельца, дословно | все |
| `<members>` | По строке на каждый сохранённый профиль: `name (id:123)` | ситуации |
| `<reference>` | Стилевой профиль как JSON: частоты пунктуации, длины, частота ответов, символы, которые не используются | ситуации, оценка |
| `<samples>` | Случайные строки из чата, по одной на строку | ситуации, оценка |
| `<signs>` | `mentor-signs.md` с заполненным `{{name}}`: известные привычки модельного текста. Опускается при отсутствии или пустом файле | все |
| `<intended>` | `labels.mentor.intended`, по строке на элемент | оценка |
| `<feedback>` | JSON-массив поправок владельца: `[{ "case": "...", "reason": "..." }]`, от новых к старым; опускается, когда пуст | все |
| `<examples>` | Реальные моменты из чата: `labels.mentor.examples` первой строкой, затем по одному `<example>` на момент. Каждый `<example>` содержит `<situation>` (сохранённый транскрипт, старейшие сообщения могут быть обрезаны под бюджет запроса) и `<original>` (сообщения персонажа). Опускается, если у кейса нет моментов | ситуации |
| `<original>` | Ответ персонажа в тот момент (в запросе оценки реального момента). `labels.mentor.original` первой строкой, затем сообщения персонажа. Заведомо плохой эталон, не ответ для оценки. Опускается для придуманных ситуаций | оценка (reply, только реальные моменты) |
| `<character>` | Карточка персонажа с заполненным `{{name}}` | оценка (только reply) |
| `<rules>` | Промпт правил | оценка |
| `<learned>` | Инструкционные усвоенные элементы, как их видит персонаж | оценка |
| `<situation>` | Ситуация, отрендеренная как транскрипт чата, как её видел персонаж. Для реального момента старейшие сообщения могут быть обрезаны под бюджет запроса; триггер не удаляется | оценка |
| `<answers>` | JSON-массив: `[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | оценка (reply) |
| `<stored>` | JSON-массив: `[{ "id": "s1a1", "texts": [{ "path": "...", "text": "..." }], "parseOk": true }]`. При `parseOk` false анализатор вернул невалидный JSON и ничего не было бы сохранено | оценка (memory) |
| `<facts>` | JSON-объект по id ответа с детерминированными измерениями (неиспользуемые знаки, редкие знаки, количество запятых, плотность запятых, длина), плюс `"repeated"` с фразами, встречающимися в двух и более различных ситуациях. По каждому ответу: `commas` — счётчик; `commaPer1000` — число только при длине измеренного текста от 150 символов, `null` для более короткого (слишком короткий для измерения; ментор оценивает счёт, не выводя плотность). `repeated` перечисляет фразы, повторившиеся в разных ситуациях, `count` — число ситуаций | оценка |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }` с результатом прохождения, медианами каждой оси, медианами по ситуациям и причинами диагностики | диагностика |
| `<worst>` | JSON: ситуация с наименьшей медианой `overall` (при равенстве: наименьший `n`; реальный момент предпочитается придуманному среди равных кандидатов): `{ n, title, transcript, answers }`, каждый ответ содержит id, messages/reactions/silent (или `texts`/`parseOk` для memory), `facts` и `score`. Транскрипт может быть обрезан под бюджет запроса | диагностика |
| `<seen>` | Полный запрос, который получил персонаж (или анализатор для memory-кейса) для этой ситуации: два подблока `<system>` (системный промпт с карточкой персонажа, правилами и форматом) и `<user>` (транскрипт, блоки памяти и задача) | диагностика |

### Идентификаторы ответов

`s<ситуация>a<сэмпл>`, оба с 1. Пример: `s2a3` — третий сэмпл второй ситуации.

### Схема ситуаций

```json
{
  "situations": [
    {
      "title": "короткая метка",
      "lines": [
        {
          "authorId": "123456789 или self",
          "authorName": "отображаемое имя",
          "text": "сообщение",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` — id участника из `<members>` или `self` для собственных строк персонажа. `replyTo` — 0-индексированный указатель на строку в массиве `lines` этой ситуации, или `null`. Для обеих целей последняя строка никогда не от `self`. Для reply-ситуаций она обращена к персонажу. Для memory-ситуаций обращение к персонажу необязательно; собственные строки персонажа могут быть где угодно до последней строки.

Запись ситуации из реального момента несёт `anchor: <id>` вместо `lines`. Её транскрипт строится из сохранённой истории; запись также содержит `original` (сообщения персонажа) и `at` (время ответа персонажа).

### Схема оценок

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": 8,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "Одно-два предложения."
    }
  ]
}
```

Каждый балл — целое число 0–10 или `null`. `overall` и `goal` всегда числа. Для memory-оценки `character` всегда `null`.

### Оси

Целые числа 0–10, 10 идеал, `null` когда нечего оценивать (никогда 5 вместо «неизвестно»).

| Ось | Что измеряет | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | Насколько не похоже на AI | Далеко от того, как пишут люди этого чата | Может быть и то и другое | Совпадает с тем, как пишут люди в эталоне |
| `character` | Соответствие карточке | Полностью не в образе | Узнаваем, но с промахами | Точно голос карточки |
| `rules` | Соблюдение правил и усвоенного | Нарушает все применимые правила | Часть соблюдает, часть нет | Соблюдает каждое применимое правило |
| `goal` | Делает то, что просит `<case>` | Делает противоположное | Частично достигает | Справляется ровно как описано |
| `overall` | Вердикт ментора | Провал по всем фронтам | Приемлемо с явными слабостями | Отлично по всем фронтам |

Для memory-оценки `character` всегда `null`, а `human` измеряет, читается ли текст как чьи-то собственные заметки о знакомых людях (10) или далеко от того, как такой человек писал бы для себя (0).

### Правило прохождения

Кейс считается пройденным, когда медиана `overall` >= `mentor.pass.score` (по умолчанию 7) И медиана `goal` >= `mentor.pass.score` И ни у одной оси медиана не ниже `mentor.pass.floor` (по умолчанию 5). Каждая ситуация тоже проверяется по минимуму: кейс проваливается, если медиана `overall` или медиана `goal` любой одной ситуации ниже `mentor.pass.floor`, какими бы ни были медианы по всем ответам. В отчёте показаны медианы `overall` и `goal` каждой ситуации. Ось, где все баллы `null`, имеет медиану `null` и не проверяется.

### Порядок доказательств при оценке

1. Поправки владельца в `<feedback>`, которые перекрывают вкус ментора.
2. Измеренный эталон (`<reference>`, `<samples>`) и детерминированные факты (`<facts>`).
3. Известные признаки модельного текста (`<signs>`). Признак никогда не перекрывает измерение или эталон.
4. Собственный вкус ментора, который предлагает, но никогда не перекрывает первые три.

### Источники

Список известных признаков в `mentor-signs.md` составлен по материалам статьи Википедии «Signs of AI writing» и навыка humanizer (MIT).

### Диагностика

После оценки, если прогон не завершился досрочно и кейс провалился или у любой ситуации медиана `overall` ниже `mentor.pass.score`, ментор делает ещё один запрос: объясняет, что в контексте персонажа привело к слабым ответам. Переключатель `mentor.diagnose` (по умолчанию `true`). Прогон через `/nep mentor check` никогда не запрашивает диагностику. Ошибка на этом шаге не проваливает прогон: он сохраняется с `diagnosis: null` и отметкой об ошибке.

Результат сохраняется в прогоне как `diagnosis` и выводится в отчёте. Это гипотезы; следующий этап проверит их измерениями и применит правки.

Слои, на которые может указывать причина: `rules` (правило в блоке правил), `prompt` (системный промпт движка, формат или задача), `card` (карточка персонажа), `self` (заметка персонажа о себе), `learned` (что люди ему объяснили), `guild` (серверная привычка или инсайд-шутка), `profile` (что персонаж помнит о человеке), `missing` (нужная инструкция отсутствует).

#### Схема диагностики

```json
{
  "summary": "один абзац",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "дословная цитата из <seen>, до 300 символов; пусто для missing",
      "why": "одно-два предложения"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "какой файл, правило или элемент",
      "from": "дословный текст для замены; пусто для добавления",
      "to": "новый текст",
      "why": "одно предложение"
    }
  ]
}
```

Не более 5 причин и 5 изменений. `summary` обрезается до 1500 символов; `excerpt` до 300; `from`/`to` до 1000; `target` до 200; `why` до 500. Элемент с неизвестным `layer` или без `why` отбрасывается. `summary` и `why` на языке чата; `to` на языке слоя, в который направлено изменение.

### Исправление

Переключатель `features.mentorAutoFix` (по умолчанию `false`). Когда `/nep mentor run` проваливается и диагностика указала причины, цикл исправления пытается превратить одну причину в верифицированную правку. До `mentor.fix.maxAttempts` (по умолчанию 3) попыток. `features.mentorAutoFix` проверяется перед каждым шагом, расходующим токены (контроль, каждая абляция, запрос правки, верификация, каждый кейс регрессии и запись).

#### Шесть шагов

1. **Контроль.** При первой необходимости абляции слабые ситуации проигрываются заново на неизменном представлении (`mentor.ablationSamples` ответов на ситуацию, фаза `repair: control`). Прирост каждой абляции измеряется относительно этого контроля, а не относительно оценок самого прогона. Повторная выборка сама по себе поднимает низкие оценки, поэтому контроль служит базовой линией. Если контроль достигает проходного балла на каждой слабой ситуации, цикл завершается с `reason: 'not reproduced'`: провал не воспроизвёлся, правка не нужна. Контроль измеряется один раз и используется повторно для каждого подозреваемого и каждой попытки.
2. **Подозреваемые.** Причины из диагностики берутся по порядку, до `mentor.suspects` (по умолчанию 2) за попытку.
3. **Абляция.** Каждый подозреваемый проверяется: слабые ситуации проигрываются на оверлее памяти с удалённым фрагментом, измеряется прирост над контролем. Подозреваемый подтверждается при приросте от `mentor.ablationGain` (по умолчанию 1). `ablationSamples` (по умолчанию 2) ответов на ситуацию. Причина `missing` (нужная инструкция отсутствует) подтверждается без абляции, контроль для неё не измеряется.
4. **Правка.** Модель ментора пишет одну правку по первому подтверждённому подозреваемому через `mentor-fix.md`. Правка проверяется на соответствие подтверждённой причине: для причины в разрешённом слое правка должна менять тот самый фрагмент (тот же файл промпта, то же правило, тот же элемент списка, то же поле гильдии, тот же участник и поле) с непустым `from`; правка в другом месте отклоняется как `not the proven cause`. Для причины `missing` или причины в слое, недоступном циклу (карточка или закрытый конфигурацией слой), допускается только добавление правила (слой `rules`, пустой `from`). Серверные `patterns` и `starters` могут быть переписаны, но не опустошены (`deletion not allowed`). Элементы `learned` и элементы `self`/шуток, превышающие лимит длины, отклоняются (`text too long`). Слой должен быть в `mentor.fix.layers`, файл промпта в `mentor.fix.files`, рост в пределах `mentor.fix.maxGrowthChars`, а правка профиля должна сохранять числа, даты, имена и упоминания.
5. **Верификация.** Правка применяется на оверлее. Свежие ситуации того же кейса (`mentor.verify.situations`, по умолчанию 3, с `mentor.verify.samples`, по умолчанию 2) должны пройти. Свежих ситуаций после фильтрации должно остаться не менее `mentor.verify.minSituations` (по умолчанию 2); при нехватке попытка отклоняется как `too few fresh situations`. Количество `kept` сохраняется в `verify.fresh`. Сохранённые ситуации каждого другого активного кейса не должны просесть более чем на `mentor.regression.tolerance` (по умолчанию 1) относительно своих записанных медиан; воспроизводится до `mentor.regression.situations` (по умолчанию 2) ситуаций на кейс. Каждое измерение в цикле (контроль, абляция, верификация, регрессия) оценивается судьёй по текущим правилам, карточке и выученным элементам, поэтому правка не сдвигает критерий, по которому её измеряют.
6. **Применение.** Только если правка прошла верификацию и `features.mentorAutoFix` по-прежнему `true`, хранилище изменений записывает правку с историей для отмены.

Попытка без подтверждённых подозреваемых, с отклонённой правкой или проваленной верификацией переходит к оставшимся подозреваемым.

#### Что может затронуть правка

Слои из `mentor.fix.layers` (по умолчанию `["rules", "prompt", "self", "learned", "guild"]`). Карточка персонажа никогда не редактируется. Файлы промптов из `mentor.fix.files` (по умолчанию `["system-prompt", "format", "reply", "memory", "profile"]`). Для reply-кейса файлы сужаются до пересечения со списком `system-prompt`, `format`, `reply`: промпты, не используемые в песочнице ответа (`interject`, `initiate`, `address` и промпты писателя памяти `memory`, `profile`, `server`, `channel`), недоступны. Memory-кейс правит только промпты писателя памяти, только через слой `prompt`. Пустой `from` на слое `rules` добавляет правило (тот же путь, что и `/nep rule add`). В профиле участника может меняться только формулировка: числа, даты, имена и упоминания `<@id>` проверяются кодом (`profileGuard`).

#### Промпт исправления

`mentor-fix.md` с заполненным `{{name}}`. Системное сообщение одного запроса ментора. Блоки в пользовательском сообщении:

| Блок | Содержимое |
|---|---|
| `<case>` | Текст кейса владельца, дословно |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }` |
| `<signs>` | Известные привычки модельного текста (может отсутствовать) |
| `<feedback>` | Поправки владельца (может отсутствовать) |
| `<cause>` | JSON: `{ layer, excerpt, why, gain }` подтверждённого подозреваемого |
| `<seen>` | Полный запрос, который видел персонаж: подблоки `<system>` и `<user>` |
| `<allowed>` | JSON: `{ layers, files, maxGrowthChars }` |

Ответ — один JSON-объект:

```json
{
  "layer": "rules|prompt|self|learned|guild|profile",
  "target": "имя файла (prompt), patterns|starters|injokes (guild), <userId>.<field> (profile), пусто (остальные)",
  "from": "дословный текст для замены; пусто для добавления",
  "to": "новый текст; пусто для удаления (только self, learned, guild items)",
  "why": "одно предложение, на языке чата"
}
```

Валидация: `layer` должен быть в `<allowed>`. Никогда `card`, никогда `missing`. `from` и `to` обрезаются до 1000 символов, `target` до 200, `why` до 500. Ответ без валидного `layer` или без `why` считается отсутствием правки.

#### Что сохраняется в прогоне

Прогон получает объект `repair`:

```
{
  control: { medians, situations },
  attempts: [{ n, suspects: [{ layer, excerpt, located, gain, confirmed }],
    edit, refused, verify: { fresh: { passed, kept, medians, situations },
    regression: [{ caseId, held, situations }], skipped } | null, accepted }],
  applied: { changeId, layer, target, summary } | null,
  reason, tokens
}
```

`control` появляется после измерения контроля (отсутствует, если цикл не дошёл до абляции, например при причине `missing`). `verify.fresh.kept` показывает, сколько свежих ситуаций прошло фильтрацию.

`reason`: `applied`, `no diagnosis`, `no suspect left`, `max attempts`, `not reproduced`, `prompt missing`, `disabled`, `budget`, `stopped by the owner`, `apply failed` или имя ошибки.

#### Записи изменений

`data/guilds/<id>/mentor/changes.json` хранит список записанных изменений: `{ nextId, changes: [...] }`. Каждое изменение содержит id, кейс, слой, цель, метку времени и сводку. Состояние до и после сохраняется в `data/guilds/<id>/mentor/changes/<id>/before.json` и `after.json`. Между записью изменения и записью фрагмента на изменении стоит `pending: true`; если бот упадёт в этом окне, следующая операция apply или undo завершит отложенную запись.

#### Локальные переопределения промптов

Отслеживаемый промпт движка никогда не записывается. Когда исправление правит файл промпта, хранилище изменений создаёт (или обновляет) локальное переопределение в `prompts.local/`, скопированное с отслеживаемого файла, и применяет правку к локальной копии. Пустой или пробельный локальный файл считается отсутствующим: переопределение строится по отслеживаемому тексту, и изменение помечается `blank: true`. Переопределение запоминает SHA-256 хеш отслеживаемого файла, SHA-256 файла в том виде, в каком его оставил ментор (`writtenHash`), и применённые патчи.

`data/guilds/<id>/mentor/overrides.json` сопоставляет каждый переопределённый промпт с `{ baseHash, writtenHash, patches: [{ changeId, from, to }] }`.

После деплоя, изменившего отслеживаемый файл, `rebase` (`/nep mentor rebase <name>`) читает новый текст, повторно применяет каждый патч, чей `from` ещё найден, отбрасывает остальные и обновляет базовый хеш и `writtenHash`. `rebase` отказывает с `edited by hand`, если текущий хеш локального файла отличается от `writtenHash` (или `writtenHash` отсутствует), и с `already current`, если отслеживаемый файл не изменился. `rebaseStatus` сообщает `handEdited: true|false` для каждого переопределения.

#### Отмена

`/nep mentor undo <id>` восстанавливает то, что правка заменила. Хранилище отказывает, если содержимое больше не совпадает с тем, что оставила правка (`changed since`), или уже отменено. Для локального файла промпта, созданного правкой (до неё файла не было), отмена удаляет файл, и отслеживаемый текст снова вступает в силу.

#### Как завершается исправление

Те же причины, что останавливают прогон, останавливают и цикл исправления: `budget`, `disabled` (ментор или переключатель autofix отключён), `stopped by the owner`. Цикл исправления никогда не изменяет измеренный прогон: его запись сохраняется рядом с вердиктом.

В карточке, публикуемой в канале администратора, показан результат исправления: `repair: change <id> applied, <layer> <target>, gain <gain>, fresh overall <median>` и `undo: /nep mentor undo <id>`, или `repair: nothing applied (<reason>)`.

## Уведомления о лимитах

Когда ограничение отклоняет запрошенное действие (упоминание, ответ, триггер по имени, follow-up или личное сообщение),
бот публикует одну строку из `labels.limits.notice` с заполненными `{limit}` (ключ конфигурации), `{used}` и `{cap}`.
Спонтанные ходы, попавшие в ограничение, молчат. В сухом прогоне уведомление логируется и зеркалируется.

Ключи конфигурации, которые могут появиться в `{limit}`: `llm.maxRequestsPerDay`, `llm.maxRequestTokens`,
`image.maxPerDay`, `image.maxPerUserPerDay`, `private.maxPerUserPerDay`, `private.maxPerOwnerPerDay`.

Приватные лимиты ЛС публикуют уведомление раз в день на человека (отслеживается через `replies.noticedDay`).
Лимиты картинок публикуют уведомление вместо хода `drawFailed` (строка восприятия уже сообщила персонажу;
уведомление — технический маркер для просившего). Лимиты видео и веба не блокируют ответ и сохраняют свои
состояния в транскрипте; уведомления нет.
