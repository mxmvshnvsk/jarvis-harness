# ADR-0015: Semantic retrieval — порт, decision gate и порядок внедрения

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §8 («Vector DB не является фундаментом архитектуры.
  Embeddings вводятся только если structural + lexical retrieval недостаточны по evals»), §21; заметка
  владельца «Vector & Semantic Retrieval» (решение: не внедрять vector DB как обязательную часть ранней
  архитектуры; evals как gate; Confluence/Jira раньше кода; semantic units вместо chunks; freshness по
  checksum) — принята как основа этого ADR; [ADR-0008](0008-incremental-project-graph.md) (ключ blobSha),
  [ADR-0010](0010-secret-redaction.md) (запрещённые пути, retention), [ADR-0012](0012-evals-and-record-replay.md)
  §3 (required evidence из human-версий), [ADR-0014](0014-config-precedence-and-migrations.md) (миграции
  и бэкапы `jarvis.db`)
- Код (план): `src/knowledge/retrieval/{retriever,query,merge,rerank}.ts`, порт
  `src/knowledge/semantic/index.port.ts`, реализации `src/knowledge/semantic/{sqliteVec,noop}.ts`,
  эмбеддер `src/knowledge/semantic/embedder/{port,local,openaiCompatible}.ts`, FTS
  `src/knowledge/lexical/fts.ts`, глоссарий `.jarvis/knowledge/glossary.md` + `src/knowledge/glossary.ts`,
  evals-набор `evals/cases/retrieval/*`

## Контекст

Knowledge Engine (ADR-0001 §8) строится на explicit project knowledge, ripgrep/FTS, git и Project Graph.
Заметка владельца фиксирует: embeddings — один из сменных индексов, не память системы и не источник
истины; вводятся после измеренного retrieval gap. С этим ADR согласен и принимает его целиком.

Четыре вещи заметка не учитывает:

1. **Разрыв кросс-языковой.** Бизнес-язык Jira/Confluence — русский, код — английский («повторная
   регистрация после отказа» ↔ `canRestartOnboarding()`). Lexical/BM25 этот разрыв не закроет в принципе,
   поэтому gate с высокой вероятностью сработает. Это не меняет порядок внедрения, но меняет планирование:
   Phase 5 надо готовить, а не «рассматривать».
2. **Embedding-модель в закрытом контуре.** Заметка выбирает VectorStore «позже», но ничего не говорит о
   модели embeddings, которая важнее хранилища: корпоративный endpoint может не отдавать `/embeddings`;
   модель обязана быть multilingual из-за п. 1; reranker тоже должен быть локальным либо LLM за квоту.
3. **Промежуточный дешёвый шаг** между lexical и embeddings — глоссарий «бизнес-термин → символы кода» как
   versioned project knowledge, который детерминированно расширяет запрос.
4. **Связь с уже принятыми решениями** — идентичность индексированных единиц, инвалидация, безопасность,
   хранилище, слияние кандидатов, источник eval-датасета.

## Решение

### 1. Принимается из заметки без изменений

- Vector index — сменный индекс рядом с FTS и Project Graph; Knowledge Store — источник истины.
- Разделение вопросов: Vector — «где примерно концепция», Graph — «что технически связано», FTS — «где
  конкретно встречается», Git — «кем и когда менялось», Jira/Confluence — «бизнес-контекст».
- Порядок: Confluence, ADR/architecture docs, domain docs, Jira descriptions, PR descriptions, артефакты
  Jarvis — да; исходный код — позже и только semantic units (function, class, component, hook, service,
  handler, module), не fixed-size chunks.
- Запреты: не чанковать весь репозиторий ради RAG; не заменять источники summary; не считать similarity
  доказательством зависимости; не отдавать top-k модели без metadata-фильтра и rerank; не индексировать
  секреты и запрещённые пути; не хранить векторы без source identity и инвалидации.
- Freshness: re-embed только изменённых единиц по checksum/version.
- Порт `SemanticIndex { upsert, remove, search }` и `Retriever { retrieve }`; core не зависит от продукта.

### 2. Порядок retrieval (уточнённый)

| Этап | Retrieval | Отличие от заметки |
| --- | --- | --- |
| v0.1 | explicit knowledge `.jarvis/knowledge/*.md` + ripgrep по коду + MCP-источники + **FTS5 по knowledge и артефактам** | FTS5 бесплатна вместе с SQLite — включается сразу, не в v0.4 |
| v0.2 | SDD-артефакты в индексе + Context Manager | — |
| v0.3 | AST + Project Graph + symbol index (ADR-0008) | — |
| v0.3½ | **глоссарий** (§3) + query expansion | новый этап |
| v0.4 | FTS5/BM25 по коду с metadata-фильтрами + retrieval evals (§6) | — |
| gate | анализ retrieval failures по §6 | — |
| v0.5 | embeddings + `SemanticIndex` + hybrid retrieval | подготовка начинается на v0.4 (§4) |
| далее | reranking + инкрементальная индексация кода | — |

### 3. Глоссарий

`.jarvis/knowledge/glossary.md` — таблица: `термин (ru/en) | синонимы | символы/модули кода | источники
(Jira/Confluence) | обновлено`. Пополняется двумя путями: Documentation-агент при `jarvis knowledge update`
и автоматически из завершённых Run — research/impact-артефакты фиксируют, какие термины задачи к каким
символам привели (`termLinks[]` в схеме артефакта), human-версии (ADR-0005) имеют приоритет. Query Analyzer
расширяет lexical-запрос по глоссарию детерминированно; расширения помечаются в trace (`retrieval.expansion`).
Это закрывает часть кросс-языкового разрыва без embeddings и уменьшает gap, который измерит §6.

### 4. Подготовка к v0.5 (делается на v0.4)

- **Инвентаризация embeddings.** Проверить, отдаёт ли корпоративный endpoint `/embeddings` и какой моделью;
  иначе — локальный multilingual-эмбеддер (bge-m3 или multilingual-e5, ONNX/квантованный, CPU, через
  `@huggingface/transformers` из внутреннего зеркала). Порт `Embedder { embed(texts): Promise<Vector[]>;
  id; version; dims }`, две реализации: `openaiCompatible`, `local`. Английская embedding-модель не
  принимается — не закрывает п. 1 контекста.
- **Reranker** — тот же выбор: локальный cross-encoder (bge-reranker) или LLM-rerank за квоту с лимитом
  кандидатов (≤ 20); решение — по evals стоимости/качества.
- **Идентичность единицы индекса** — `(sourceId, sourceVersion, embedderId, embedderVersion)`. Для кода
  `sourceVersion = blobSha` (ADR-0008) — инвалидация одна на графы и векторы; для Confluence — version
  страницы, для Jira — `updated`. Смена эмбеддера = новый индекс, смешивание запрещено схемой.
- **Метаданные** как в заметке (`type, symbol, file, module, commit, graphNodeId`) плюс `blobSha`,
  `sourceKind`, `lang`, `freshness`.

### 5. Хранилище, безопасность, слияние

- Local-first реализация — `sqlite-vec` в том же `jarvis.db`: без новой инфраструктуры, те же миграции и
  `.bak` (ADR-0014). Qdrant/pgvector/LanceDB — реализации порта для shared runtime, не для v0.5.
- Индексация подчиняется ADR-0010: запрещённые пути и типы не индексируются; содержимое проходит Redactor
  до эмбеддинга. Локальный индекс Confluence/Jira — копии корпоративных документов на машине разработчика:
  retention как у artifact store, в бандлы (ADR-0009) векторы не включаются (пересчитываются при импорте).
- Candidate Merger — Reciprocal Rank Fusion по спискам lexical / semantic / structural, без обучаемых
  весов; metadata-фильтры — до слияния. Reranker — на ≤ 20 кандидатах. Context Selector получает evidence с
  `retrievalPath[]` (какой индекс и с каким рангом нашёл) — это идёт в trace.

### 6. Evals и gate

Набор `evals/cases/retrieval/*`: задача → required evidence. Источники кейсов: рукописные для fixture-
репозиториев и автоматически из human-версий spec/impact завершённых Run (ADR-0012 §3) — ссылки, на которые
опирался человек, и есть required evidence. Метрики из заметки: Recall@5/@10, MRR, required-dependency
recall, irrelevant-context ratio, retrieved tokens, task success / human corrections.

Gate для v0.5 (как в заметке, формализованный): прогон ADR-0012 §5 на v0.4 без embeddings; если
Required-source Recall@10 ниже целевого (стартово 0.9) **и** разбор промахов показывает semantic/cross-
lingual mismatch (а не дыры графа или FTS) в большинстве случаев — embeddings внедряются; после внедрения
вариант «с/без» обязан улучшить Recall без ухудшения irrelevant-context ratio и retrieved tokens сверх
допуска. Результат прикладывается к этому ADR как дополнение с датой.

## Последствия

- Решение заметки сохранено: без измеренного gap embeddings не появляются.
- Phase 5 не упрётся в инфраструктуру: модель, хранилище и идентичность единиц определены заранее.
- Глоссарий даёт часть эффекта раньше и как версионируемое знание проекта.
- Единая инвалидация по `blobSha` для графа и векторов; одна БД, одни миграции.
- Стоимость: локальный эмбеддер — CPU-время при индексации Confluence; ограничивается набором
  пространств/страниц в `project.yaml: knowledge.sources`.

## Альтернативы

- **Vector DB с первого этапа.** Отвергнуто заметкой и ADR-0001: недоказуемая польза, стоимость
  индексации и свежести.
- **Внешний vector-сервис сразу.** Противоречит local-first; остаётся реализацией порта для shared runtime.
- **Только глоссарий без embeddings.** Возможный итог, если gate не сработает; ADR это допускает — §6 решает.
- **Чанкование всего кода.** Отвергнуто: шум, ложные связи, расход контекста.
