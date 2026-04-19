# FindDockerEnv

CLI-утилита для поиска образов в Docker Hub и проверки, содержится ли `.env` в файловой системе контейнера.

Что делает:

1. Ищет репозитории по ключевому слову и берёт сначала последние обновлённые образы, а не `best match`.
2. Отбирает только репозитории с `pull_count` меньше заданного порога.
3. По очереди или параллельно запускает контейнеры.
4. Останавливает контейнер.
5. Копирует все файлы контейнера во временную директорию через `docker cp <container>:.`.
6. Проверяет, есть ли в скопированном содержимом файл `.env`.
7. Если `.env` найден, копирует его в папку `result` с именем образа.
8. После обработки удаляет остановленный контейнер и скачанный образ.
9. Печатает в консоль прогресс обработки в формате `Processed X/Y`.

## Запуск

```bash
python3 docker_hub_env_finder.py fastapi
```

Пример с JSON-выводом и сохранением временных папок:

```bash
python3 docker_hub_env_finder.py fastapi --output-json --keep-temp
```

Пример с отчётом:

```bash
python3 docker_hub_env_finder.py fastapi --report-file reports/result.json
python3 docker_hub_env_finder.py fastapi --report-file reports/result.csv
```

Пример с отдельной папкой для найденных `.env`:

```bash
python3 docker_hub_env_finder.py fastapi --result-dir result
```

Пример с параллельной обработкой:

```bash
python3 docker_hub_env_finder.py trading_bot --max-results 150 --workers 4 --start-from-index 100
```

Пример продолжения с 230-й позиции:

```bash
python3 docker_hub_env_finder.py fastapi --start-from-index 230
```

Скрипт вычисляет стартовую страницу как `230 / page_size` и начинает поиск сразу с неё, а не с первой страницы.

Пример продолжения с конкретного образа:

```bash
python3 docker_hub_env_finder.py fastapi --start-from-image owner/repo
```

Если в Python-окружении есть проблемы с TLS-сертификатами:

```bash
python3 docker_hub_env_finder.py fastapi --insecure
```

## Аргументы

- `query` — поисковое слово для Docker Hub.
- `--max-results` — максимум образов для анализа после фильтрации.
- `--max-pulls` — верхний порог по количеству скачиваний, по умолчанию `500`.
- `--page-size` — размер страницы поиска Docker Hub.
- `--max-pages` — максимум страниц поиска, чтобы не обходить слишком много результатов.
- `--start-timeout` — сколько ждать после старта контейнера перед остановкой.
- `--keep-temp` — не удалять временные директории.
- `--start-from-image` — начать сканирование с указанного `owner/repo`.
- `--start-from-index` — начать сканирование с указанной позиции; стартовая страница вычисляется автоматически.
- `--workers` — количество параллельных проверок.
- `--report-file` — сохранить отчёт в `.json` или `.csv`.
- `--result-dir` — папка, куда копируются найденные `.env`.
- `--output-json` — печатать результаты в JSON в консоль.
- `--insecure` — отключить TLS-проверку сертификата для запросов к Docker Hub.

## Статусы результата

- `ok` — файлы контейнера скопированы, проверка завершена.
- `copy_failed` — не удалось скопировать файловую систему контейнера.
- `pull_failed` — образ не удалось скачать.
- `unsupported_manifest` — образ использует старый manifest schema v1, который не поддерживается современным Docker/containerd.
- `create_failed` — контейнер не удалось создать.
- `start_failed` — контейнер не удалось запустить.

## Требования

- Python 3.10+
- Docker CLI
- Доступ к Docker daemon

## Тесты

```bash
python3 -m unittest discover -s tests
```
