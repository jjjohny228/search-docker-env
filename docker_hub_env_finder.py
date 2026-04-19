import argparse
import csv
import json
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import parse, request
from urllib.error import HTTPError, URLError


DOCKER_HUB_SEARCH_URL = "https://hub.docker.com/v2/search/repositories/"
DOCKER_HUB_TAGS_URL = "https://hub.docker.com/v2/namespaces/{namespace}/repositories/{name}/tags"
_IMAGE_USAGE_LOCK = threading.Lock()
_IMAGE_USAGE_COUNTS: dict[str, int] = {}


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
    error: str | None = None


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
    parser.add_argument("query", help="Search query for Docker Hub.")
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


def find_env_file(directory: Path) -> Path | None:
    for path in directory.rglob(".env"):
        return path
    return None


def contains_env_file(directory: Path) -> bool:
    return find_env_file(directory) is not None


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


def classify_pull_error(error: str) -> str:
    normalized = error.lower()
    if "manifest.v1+prettyjws" in normalized or "no longer supported since containerd" in normalized:
        return "unsupported_manifest"
    return "pull_failed"


def choose_pullable_image_reference(candidate: RepositoryCandidate, insecure: bool = False) -> tuple[str | None, str | None, str | None]:
    last_error: str | None = None
    last_status: str | None = None

    for image_reference in get_image_references(candidate, insecure=insecure):
        pull_result = run_command(["docker", "pull", image_reference], check=False)
        if pull_result.returncode == 0:
            return image_reference, None, None

        last_error = pull_result.stderr.strip() or pull_result.stdout.strip() or "docker pull failed"
        last_status = classify_pull_error(last_error)

    return None, last_status or "pull_failed", last_error or "docker pull failed"


def copy_found_env(env_path: Path, result_dir: Path, image: str) -> Path:
    result_dir.mkdir(parents=True, exist_ok=True)
    safe_name = make_safe_image_name(image)
    destination = result_dir / f"{safe_name}.env"
    shutil.copy2(env_path, destination)
    return destination


def scan_repository(
    candidate: RepositoryCandidate,
    start_timeout: float,
    keep_temp: bool,
    result_dir: Path,
    insecure: bool,
) -> ScanResult:
    container_name = f"find-docker-env-{uuid.uuid4().hex[:12]}"
    temp_dir_path = Path(tempfile.mkdtemp(prefix=f"find-docker-env-{make_safe_image_name(candidate.image)}-"))
    resolved_image: str | None = None
    resolved_image_id: str | None = None

    try:
        try:
            resolved_image, pull_status, pull_error = choose_pullable_image_reference(candidate, insecure=insecure)
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

        create_result = run_command(["docker", "create", "--name", container_name, resolved_image], check=False)
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
        env_path = find_env_file(copied_root) if files_copied and copied_root is not None else None
        env_found = env_path is not None
        env_saved_to = copy_found_env(env_path, result_dir, resolved_image) if env_path and resolved_image else None

        return ScanResult(
            image=resolved_image,
            pull_count=candidate.pull_count,
            temp_dir=temp_dir_path if keep_temp else None,
            files_copied=files_copied,
            env_found=env_found,
            status="ok" if files_copied else "copy_failed",
            env_source=env_path,
            env_saved_to=env_saved_to,
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
        print(f".env found: {'yes' if result.env_found else 'no'}")
        if result.env_source:
            print(f".env source: {result.env_source}")
        if result.env_saved_to:
            print(f".env saved to: {result.env_saved_to}")
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
                insecure=insecure,
            )
            results.append(result)
            print(f"Processed {index}/{total}: {result.image} [{result.status}]", file=sys.stderr)
        return results

    results_by_index: dict[int, ScanResult] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(scan_repository, candidate, start_timeout, keep_temp, result_dir, insecure): index
            for index, candidate in enumerate(candidates)
        }
        processed = 0
        for future in as_completed(future_map):
            result_index = future_map[future]
            result = future.result()
            results_by_index[result_index] = result
            processed += 1
            print(f"Processed {processed}/{total}: {result.image} [{result.status}]", file=sys.stderr)

    return [results_by_index[index] for index in sorted(results_by_index)]


def main() -> int:
    args = parse_args()

    try:
        ensure_docker_available()
        start_page = calculate_start_page(args.start_from_index, args.page_size)
        page_offset = calculate_page_offset(args.start_from_index, args.page_size)
        candidates = search_repositories(
            query=args.query,
            max_pulls=args.max_pulls,
            max_results=args.max_results,
            page_size=args.page_size,
            max_pages=args.max_pages,
            start_page=start_page,
            insecure=args.insecure,
        )
        candidates = slice_candidates(
            candidates,
            start_from_index=page_offset + 1,
            start_from_image=args.start_from_image,
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
        insecure=args.insecure,
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
