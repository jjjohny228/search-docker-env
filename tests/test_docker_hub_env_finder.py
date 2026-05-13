import csv
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from docker_hub_env_finder import (
    _IMAGE_USAGE_COUNTS,
    _KNOWN_IMAGE_IDS,
    AppConfig,
    MANAGED_CONTAINER_LABEL,
    build_r2_key,
    calculate_page_offset,
    calculate_start_page,
    cleanup_docker_storage,
    choose_pullable_image_reference,
    chunk_paths,
    classify_pull_error,
    collect_unprocessed_candidates,
    copy_found_files,
    RepositoryCandidate,
    ScanResult,
    cleanup_image,
    contains_env_file,
    copy_found_env,
    execute_scan,
    extract_image_parts,
    fetch_namespace_repositories_page,
    fetch_search_page,
    fetch_tags_page,
    find_env_file,
    find_sensitive_files,
    get_message_text,
    filter_unprocessed_candidates,
    get_image_references,
    init_db,
    is_authorized_admin,
    is_image_processed,
    mark_image_processed,
    make_safe_image_name,
    pause_on_rate_limit,
    parse_telegram_retry_after,
    probe_namespace_endpoint,
    probe_namespace_endpoints,
    rotate_proxy,
    save_report,
    scan_repository,
    scan_repositories,
    send_telegram_file_groups,
    send_telegram_message,
    list_namespace_repositories,
    search_repositories,
    slice_candidates,
    sync_proxy_state,
    upload_files_to_r2,
    validate_socks5_proxy,
    wait_with_stop,
    should_mark_processed,
)
from telegram_control_bot import (
    SCAN_MODE_USER_IMAGES,
    awaiting_query_keyboard,
    describe_scan_target,
    finished_scan_text,
    idle_keyboard,
    mode_keyboard,
    scope_keyboard,
    running_keyboard,
)


TEST_CONFIG = AppConfig(Path("state.db"), 1, None, [])


class BaseStatefulTests(unittest.TestCase):
    def setUp(self) -> None:
        _IMAGE_USAGE_COUNTS.clear()
        _KNOWN_IMAGE_IDS.clear()


class ContainsEnvFileTests(BaseStatefulTests):
    def test_detects_env_file_recursively(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            nested = root / "app" / "config"
            nested.mkdir(parents=True)
            (nested / ".env").write_text("SECRET=1", encoding="utf-8")

            self.assertTrue(contains_env_file(root))
            self.assertEqual(find_env_file(root), nested / ".env")

    def test_detects_multiple_sensitive_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            app_dir = root / "app"
            app_dir.mkdir(parents=True)
            (app_dir / ".env.production").write_text("SECRET=1", encoding="utf-8")
            (app_dir / "config.json").write_text('{"token":"1"}', encoding="utf-8")
            (app_dir / "README.md").write_text("deployment notes", encoding="utf-8")
            (app_dir / ".env.example").write_text("PUBLIC=1", encoding="utf-8")
            (app_dir / "settings.py").write_text("DEBUG=False", encoding="utf-8")

            matches = find_sensitive_files(root)

            self.assertEqual(
                [path.name for path in matches],
                [".env.production", "config.json", "README.md"],
            )

    def test_limits_readme_matches_to_four(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            for index in range(6):
                readme_dir = root / f"service_{index}"
                readme_dir.mkdir(parents=True)
                (readme_dir / "README.md").write_text(f"notes {index}", encoding="utf-8")

            matches = find_sensitive_files(root)

            self.assertEqual(len(matches), 4)
            self.assertTrue(all(path.name == "README.md" for path in matches))

    def test_returns_false_when_env_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "app").mkdir()

            self.assertFalse(contains_env_file(root))
            self.assertIsNone(find_env_file(root))


class ResultFileTests(BaseStatefulTests):
    def test_make_safe_image_name(self) -> None:
        self.assertEqual(make_safe_image_name("alice/project:latest"), "alice_project_latest")

    def test_copy_found_env_saves_with_image_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = root / "scan" / ".env"
            source.parent.mkdir(parents=True)
            source.write_text("KEY=VALUE", encoding="utf-8")

            saved = copy_found_env(source, root / "result", "alice/project:latest")

            self.assertEqual(saved, root / "result" / "alice_project_latest" / ".env")
            self.assertEqual(saved.read_text(encoding="utf-8"), "KEY=VALUE")

    def test_copy_found_files_flattens_names_under_image_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            scan_root = root / "scan"
            config_dir = scan_root / "app" / "config"
            config_dir.mkdir(parents=True)
            first = config_dir / ".env.local"
            second = scan_root / "config.json"
            first.write_text("KEY=VALUE", encoding="utf-8")
            second.write_text('{"token":"1"}', encoding="utf-8")

            saved = copy_found_files([first, second], scan_root, root / "result", "alice/project:latest")

            self.assertEqual(
                saved,
                [
                    root / "result" / "alice_project_latest" / ".env.local",
                    root / "result" / "alice_project_latest" / "config.json",
                ],
            )

    def test_copy_found_files_flattens_duplicate_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            first = root / "scan1" / ".env"
            second = root / "scan2" / ".env"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text("A=1", encoding="utf-8")
            second.write_text("B=2", encoding="utf-8")

            saved = copy_found_files([first, second], root, root / "result", "alice/project:latest")

            self.assertEqual(
                saved,
                [
                    root / "result" / "alice_project_latest" / ".env",
                    root / "result" / "alice_project_latest" / ".env_2",
                ],
            )

    def test_classify_pull_error_for_legacy_manifest(self) -> None:
        error = (
            'Error response from daemon: not implemented: media type '
            '"application/vnd.docker.distribution.manifest.v1+prettyjws" '
            "is no longer supported since containerd v2.1"
        )

        self.assertEqual(classify_pull_error(error), "unsupported_manifest")

    def test_classify_pull_error_for_disk_full(self) -> None:
        self.assertEqual(classify_pull_error("write /tmp/file: no space left on device"), "disk_full")

    @patch("docker_hub_env_finder.time.sleep")
    @patch("docker_hub_env_finder.send_telegram_message")
    def test_pause_on_rate_limit_uses_config_delay(self, send_telegram_message_mock, sleep_mock) -> None:
        config = AppConfig(Path("state.db"), 1.5, "token", ["1"])

        pause_on_rate_limit(config, "alice/project:1")

        sleep_mock.assert_called_once_with(5400.0)
        send_telegram_message_mock.assert_called_once()

    def test_chunk_paths(self) -> None:
        paths = [Path(f"file_{index}.txt") for index in range(12)]
        chunks = chunk_paths(paths, 10)

        self.assertEqual(len(chunks), 2)
        self.assertEqual(len(chunks[0]), 10)
        self.assertEqual(len(chunks[1]), 2)

    def test_parse_telegram_retry_after(self) -> None:
        error = 'HTTP 429: {"ok":false,"parameters":{"retry_after":13}}'
        self.assertEqual(parse_telegram_retry_after(error), 13)

    def test_telegram_keyboards_include_expected_buttons(self) -> None:
        self.assertIn("Start", idle_keyboard())
        self.assertIn("Cancel", awaiting_query_keyboard())
        self.assertIn("Search", mode_keyboard())
        self.assertIn("User Images", mode_keyboard())
        self.assertIn("Skip Processed", scope_keyboard())
        self.assertIn("Scan All", scope_keyboard())
        self.assertIn("Finish", running_keyboard())

    def test_user_images_text_is_descriptive(self) -> None:
        self.assertEqual(describe_scan_target("openai", SCAN_MODE_USER_IMAGES), "user images 'openai'")
        self.assertIn("Processed 3 images", finished_scan_text("openai", 3, 1, SCAN_MODE_USER_IMAGES))

    def test_get_message_text_extracts_chat_id_and_text(self) -> None:
        update = {"message": {"chat": {"id": 123}, "text": " hello "}}
        self.assertEqual(get_message_text(update), ("123", "hello"))

    def test_is_authorized_admin_accepts_known_chat(self) -> None:
        config = AppConfig(Path("state.db"), 1, "token", ["123"])
        self.assertTrue(is_authorized_admin(config, "123"))
        self.assertFalse(is_authorized_admin(config, "456"))

    @patch("docker_hub_env_finder.scan_repositories", return_value=[])
    @patch("docker_hub_env_finder.collect_unprocessed_candidates", return_value=[])
    @patch("docker_hub_env_finder.init_db")
    @patch("docker_hub_env_finder.ensure_docker_available")
    def test_execute_scan_passes_user_images_override(
        self,
        ensure_docker_available_mock,
        init_db_mock,
        collect_unprocessed_candidates_mock,
        scan_repositories_mock,
    ) -> None:
        args = Namespace(
            query=None,
            user_images=None,
            max_pulls=500,
            max_results=10,
            page_size=100,
            max_pages=20,
            start_from_index=1,
            start_from_image=None,
            ignore_db=False,
            insecure=False,
            start_timeout=1.0,
            keep_temp=False,
            workers=1,
            result_dir="result",
        )

        exit_code, results = execute_scan(args, TEST_CONFIG, user_images_override="openai")

        self.assertEqual(exit_code, 0)
        self.assertEqual(results, [])
        collect_unprocessed_candidates_mock.assert_called_once()
        self.assertEqual(collect_unprocessed_candidates_mock.call_args.kwargs["query"], None)
        self.assertEqual(collect_unprocessed_candidates_mock.call_args.kwargs["user_images"], "openai")
        scan_repositories_mock.assert_called_once()

    @patch("docker_hub_env_finder.scan_repositories", return_value=[])
    @patch("docker_hub_env_finder.collect_unprocessed_candidates", return_value=[])
    @patch("docker_hub_env_finder.init_db")
    @patch("docker_hub_env_finder.ensure_docker_available")
    def test_execute_scan_passes_ignore_db_override(
        self,
        ensure_docker_available_mock,
        init_db_mock,
        collect_unprocessed_candidates_mock,
        scan_repositories_mock,
    ) -> None:
        args = Namespace(
            query="fastapi",
            user_images=None,
            max_pulls=500,
            max_results=10,
            page_size=100,
            max_pages=20,
            start_from_index=1,
            start_from_image=None,
            ignore_db=False,
            insecure=False,
            start_timeout=1.0,
            keep_temp=False,
            workers=1,
            result_dir="result",
        )

        exit_code, results = execute_scan(args, TEST_CONFIG, ignore_db_override=True)

        self.assertEqual(exit_code, 0)
        self.assertEqual(results, [])
        self.assertTrue(collect_unprocessed_candidates_mock.call_args.kwargs["ignore_db"])
        self.assertTrue(scan_repositories_mock.call_args.kwargs["ignore_db"])

    def test_wait_with_stop_returns_true_when_event_is_set(self) -> None:
        stop_event = unittest.mock.Mock()
        stop_event.wait.return_value = True
        self.assertTrue(wait_with_stop(1.0, stop_event=stop_event))
        stop_event.wait.assert_called_once_with(1.0)

    def test_validate_socks5_proxy(self) -> None:
        self.assertEqual(validate_socks5_proxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080")
        self.assertEqual(validate_socks5_proxy("socks5h://user:pass@127.0.0.1:1080"), "socks5h://user:pass@127.0.0.1:1080")
        self.assertIsNone(validate_socks5_proxy("http://127.0.0.1:8080"))

    def test_sync_proxy_state_removes_invalid_entries_and_rotates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            proxy_file = root / "proxies.txt"
            proxy_file.write_text(
                "socks5://127.0.0.1:1080\ninvalid\nsocks5h://127.0.0.2:1080\n",
                encoding="utf-8",
            )
            config = AppConfig(
                Path(root / "state.db"),
                1,
                None,
                [],
                proxy_file_path=proxy_file,
                proxy_state_path=root / "proxy_state.json",
            )

            proxies = sync_proxy_state(config)
            next_proxy, wrapped = rotate_proxy(config)

            self.assertEqual(proxies, ["socks5://127.0.0.1:1080", "socks5h://127.0.0.2:1080"])
            self.assertEqual(
                proxy_file.read_text(encoding="utf-8"),
                "socks5://127.0.0.1:1080\nsocks5h://127.0.0.2:1080\n",
            )
            self.assertEqual(next_proxy, "socks5h://127.0.0.2:1080")
            self.assertFalse(wrapped)

    @patch("docker_hub_env_finder.send_telegram_multipart_request")
    def test_send_telegram_file_groups_sends_grouped_documents(self, send_telegram_multipart_request_mock) -> None:
        send_telegram_multipart_request_mock.return_value = (True, None)
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            files = []
            for index in range(3):
                file_path = root / f".env_{index}"
                file_path.write_text("KEY=VALUE", encoding="utf-8")
                files.append(file_path)

            config = AppConfig(Path("state.db"), 1, "token", ["1"])
            send_telegram_file_groups(config, "alice/project:1", files)

        self.assertEqual(send_telegram_multipart_request_mock.call_count, 1)

    @patch("docker_hub_env_finder.time.sleep")
    @patch("docker_hub_env_finder.send_telegram_multipart_request")
    def test_send_telegram_file_groups_retries_on_rate_limit(
        self,
        send_telegram_multipart_request_mock,
        sleep_mock,
    ) -> None:
        send_telegram_multipart_request_mock.side_effect = [
            (False, 'HTTP 429: {"ok":false,"parameters":{"retry_after":3}}'),
            (True, None),
        ]
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            file_path = root / ".env"
            file_path.write_text("KEY=VALUE", encoding="utf-8")

            config = AppConfig(Path("state.db"), 1, "token", ["1"])
            send_telegram_file_groups(config, "alice/project:1", [file_path])

        sleep_mock.assert_called_once_with(3)
        self.assertEqual(send_telegram_multipart_request_mock.call_count, 2)

    @patch("docker_hub_env_finder.send_telegram_form_request")
    def test_send_telegram_message_truncates_long_text(self, send_telegram_form_request_mock) -> None:
        send_telegram_form_request_mock.return_value = (True, None)
        config = AppConfig(Path("state.db"), 1, "token", ["1"])

        send_telegram_message(config, "x" * 5000)

        sent_text = send_telegram_form_request_mock.call_args.args[2]["text"]
        self.assertLessEqual(len(sent_text), 4096)

    def test_build_r2_key(self) -> None:
        config = AppConfig(
            Path("state.db"),
            1,
            None,
            [],
            r2_bucket_prefix="findings",
        )

        self.assertEqual(build_r2_key(config, "alice/project:1"), "findings/alice_project_1")
        self.assertEqual(build_r2_key(config, "alice/project:1", ".env"), "findings/alice_project_1/.env")

    @patch("docker_hub_env_finder.get_r2_client")
    def test_upload_files_to_r2_uploads_folder_placeholder_and_files(self, get_r2_client_mock) -> None:
        client = get_r2_client_mock.return_value
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            file_path = root / ".env"
            file_path.write_text("KEY=VALUE", encoding="utf-8")
            config = AppConfig(
                Path("state.db"),
                1,
                None,
                [],
                r2_bucket_name="bucket",
                r2_bucket_prefix="findings",
            )

            upload_files_to_r2(config, "alice/project:1", [file_path])

        client.put_object.assert_called_once_with(Bucket="bucket", Key="findings/alice_project_1/", Body=b"")
        client.upload_file.assert_called_once_with(
            str(file_path),
            "bucket",
            "findings/alice_project_1/.env",
        )


class SearchRepositoriesTests(BaseStatefulTests):
    @patch("docker_hub_env_finder.request.urlopen")
    def test_probe_namespace_endpoint_reports_success_payload(self, urlopen_mock) -> None:
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "count": 26,
                "next": "https://hub.docker.com/v2/namespaces/jjjohny228/repositories?page=2&page_size=2",
                "results": [
                    {"name": "time-app-frontend"},
                    {"name": "time-app-backend"},
                ],
            }
        ).encode("utf-8")
        urlopen_mock.return_value = response

        result = probe_namespace_endpoint(
            "https://hub.docker.com/v2/namespaces/jjjohny228/repositories?page_size=2"
        )

        self.assertEqual(result["status_code"], 200)
        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 26)
        self.assertEqual(result["sample_names"], ["time-app-frontend", "time-app-backend"])

    @patch("docker_hub_env_finder.probe_namespace_endpoint")
    def test_probe_namespace_endpoints_returns_both_candidate_urls(self, probe_namespace_endpoint_mock) -> None:
        probe_namespace_endpoint_mock.side_effect = [
            {"url": "first", "ok": True, "status_code": 200},
            {"url": "second", "ok": True, "status_code": 200},
        ]
        results = probe_namespace_endpoints("jjjohny228", page_size=2)

        self.assertEqual(len(results), 2)
        self.assertEqual([item["url"] for item in results], ["first", "second"])
        self.assertEqual(
            [call.args[0] for call in probe_namespace_endpoint_mock.call_args_list],
            [
                "https://hub.docker.com/v2/namespaces/jjjohny228/repositories?page=1&page_size=2&ordering=-last_updated",
                "https://hub.docker.com/v2/repositories/jjjohny228?page=1&page_size=2&ordering=-last_updated",
            ],
        )

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_namespace_repositories_page_falls_back_to_legacy_endpoint(self, urlopen_mock) -> None:
        primary_error = HTTPError(
            url="https://hub.docker.com/v2/namespaces/alice/repositories?page=1&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )
        legacy_response = unittest.mock.MagicMock()
        legacy_response.__enter__.return_value.read.return_value = json.dumps({"next": "", "results": []}).encode("utf-8")
        legacy_response.__enter__.return_value.__iter__ = None

        urlopen_mock.side_effect = [primary_error, legacy_response]

        payload = fetch_namespace_repositories_page("alice", 1, 100)

        self.assertEqual(payload, {"next": "", "results": []})
        self.assertEqual(urlopen_mock.call_count, 2)

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_namespace_repositories_page_raises_clear_error_for_missing_namespace(self, urlopen_mock) -> None:
        primary_error = HTTPError(
            url="https://hub.docker.com/v2/namespaces/missing/repositories?page=1&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )
        legacy_error = HTTPError(
            url="https://hub.docker.com/v2/repositories/missing?page=1&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )
        urlopen_mock.side_effect = [primary_error, legacy_error]

        with self.assertRaises(RuntimeError) as ctx:
            fetch_namespace_repositories_page("missing", 1, 100)

        self.assertIn("Namespace='missing'", str(ctx.exception))

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_search_page_raises_clear_error_for_http_404(self, urlopen_mock) -> None:
        urlopen_mock.side_effect = HTTPError(
            url="https://hub.docker.com/v2/search/repositories/?query=test&page=1&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )

        with self.assertRaises(RuntimeError) as ctx:
            fetch_search_page("test", 1, 100)

        self.assertIn("Docker Hub search request failed with HTTP 404", str(ctx.exception))

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_search_page_treats_page_overflow_as_empty_page(self, urlopen_mock) -> None:
        urlopen_mock.side_effect = HTTPError(
            url="https://hub.docker.com/v2/search/repositories/?query=ofm&page=3&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )

        payload = fetch_search_page("ofm", 3, 100)

        self.assertEqual(payload["results"], [])
        self.assertIsNone(payload["next"])

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_tags_page_raises_clear_error_for_http_404(self, urlopen_mock) -> None:
        urlopen_mock.side_effect = HTTPError(
            url="https://hub.docker.com/v2/namespaces/alice/repositories/app/tags?page_size=25&ordering=last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )

        with self.assertRaises(RuntimeError) as ctx:
            fetch_tags_page("alice", "app")

        self.assertIn("Docker Hub tags request failed with HTTP 404", str(ctx.exception))

    @patch("docker_hub_env_finder.request.urlopen")
    def test_fetch_namespace_repositories_page_treats_page_overflow_as_empty_page(self, urlopen_mock) -> None:
        page_overflow_error = HTTPError(
            url="https://hub.docker.com/v2/namespaces/jjjohny228/repositories?page=2&page_size=100&ordering=-last_updated",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )
        urlopen_mock.side_effect = [page_overflow_error]

        payload = fetch_namespace_repositories_page("jjjohny228", 2, 100)

        self.assertEqual(payload["results"], [])
        self.assertIsNone(payload["next"])

    @patch("docker_hub_env_finder.fetch_namespace_repositories_page")
    def test_list_namespace_repositories_reads_user_repositories(self, fetch_namespace_repositories_page_mock) -> None:
        fetch_namespace_repositories_page_mock.return_value = {
            "next": "",
            "results": [
                {
                    "name": "service-one",
                    "namespace": "alice",
                    "pull_count": 12,
                    "repository_type": "image",
                    "description": "svc",
                },
                {
                    "name": "service-two",
                    "namespace": "alice",
                    "pull_count": 700,
                    "repository_type": "image",
                    "description": "too popular",
                },
            ],
        }

        results = list_namespace_repositories(
            namespace="alice",
            max_pulls=500,
            max_results=10,
            page_size=100,
            max_pages=5,
        )

        self.assertEqual(
            results,
            [
                RepositoryCandidate(
                    name="service-one",
                    namespace="alice",
                    repository_type="image",
                    pull_count=12,
                    description="svc",
                )
            ],
        )

    def test_calculate_start_page(self) -> None:
        self.assertEqual(calculate_start_page(230, 100), 3)

    def test_calculate_page_offset(self) -> None:
        self.assertEqual(calculate_page_offset(230, 100), 29)

    def test_slice_candidates_starts_from_index(self) -> None:
        candidates = [
            RepositoryCandidate("one", "alice", "image", 1, ""),
            RepositoryCandidate("two", "alice", "image", 1, ""),
            RepositoryCandidate("three", "alice", "image", 1, ""),
        ]

        sliced = slice_candidates(candidates, start_from_index=2)

        self.assertEqual([item.image for item in sliced], ["alice/two", "alice/three"])

    def test_slice_candidates_starts_from_image(self) -> None:
        candidates = [
            RepositoryCandidate("one", "alice", "image", 1, ""),
            RepositoryCandidate("two", "alice", "image", 1, ""),
            RepositoryCandidate("three", "alice", "image", 1, ""),
        ]

        sliced = slice_candidates(candidates, start_from_image="alice/two")

        self.assertEqual([item.image for item in sliced], ["alice/two", "alice/three"])

    @patch("docker_hub_env_finder.fetch_tags_page")
    def test_get_image_references_uses_latest_tags(self, fetch_tags_page) -> None:
        fetch_tags_page.return_value = {
            "results": [
                {"name": "32.0.0"},
                {"name": "31.0.0"},
            ]
        }

        resolved = get_image_references(RepositoryCandidate("1win4games", "jjjohny228", "image", 1, ""))

        self.assertEqual(resolved, ["jjjohny228/1win4games:32.0.0", "jjjohny228/1win4games:31.0.0"])

    @patch("docker_hub_env_finder.run_command")
    @patch("docker_hub_env_finder.get_image_references")
    def test_choose_pullable_image_reference_falls_back_to_next_tag(
        self,
        get_image_references_mock,
        run_command_mock,
    ) -> None:
        get_image_references_mock.return_value = [
            "jjjohny228/1win4games:32.0.0",
            "jjjohny228/1win4games:31.0.0",
        ]
        run_command_mock.side_effect = [
            type("CP", (), {"returncode": 1, "stderr": "manifest.v1+prettyjws", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
        ]

        image, status, error = choose_pullable_image_reference(
            RepositoryCandidate("1win4games", "jjjohny228", "image", 1, ""),
            config=TEST_CONFIG,
        )

        self.assertEqual(image, "jjjohny228/1win4games:31.0.0")
        self.assertIsNone(status)
        self.assertIsNone(error)

    @patch("docker_hub_env_finder.cleanup_docker_storage")
    @patch("docker_hub_env_finder.time.sleep")
    @patch("docker_hub_env_finder.run_command")
    @patch("docker_hub_env_finder.get_image_references")
    def test_choose_pullable_image_reference_retries_after_disk_cleanup(
        self,
        get_image_references_mock,
        run_command_mock,
        sleep_mock,
        cleanup_docker_storage_mock,
    ) -> None:
        get_image_references_mock.return_value = ["alice/project:1"]
        cleanup_docker_storage_mock.return_value = True
        _IMAGE_USAGE_COUNTS["sha256:active"] = 1
        run_command_mock.side_effect = [
            type("CP", (), {"returncode": 1, "stderr": "no space left on device", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
        ]

        image, status, error = choose_pullable_image_reference(
            RepositoryCandidate("project", "alice", "image", 1, ""),
            config=TEST_CONFIG,
        )

        self.assertEqual(image, "alice/project:1")
        self.assertIsNone(status)
        self.assertIsNone(error)
        cleanup_docker_storage_mock.assert_called_once()
        sleep_mock.assert_called_once_with(2.0)

    @patch("docker_hub_env_finder.cleanup_docker_storage")
    @patch("docker_hub_env_finder.time.sleep")
    @patch("docker_hub_env_finder.run_command")
    @patch("docker_hub_env_finder.get_image_references")
    def test_choose_pullable_image_reference_stops_after_failed_disk_cleanup(
        self,
        get_image_references_mock,
        run_command_mock,
        sleep_mock,
        cleanup_docker_storage_mock,
    ) -> None:
        get_image_references_mock.return_value = ["alice/project:1", "alice/project:2"]
        cleanup_docker_storage_mock.return_value = False
        run_command_mock.side_effect = [
            type("CP", (), {"returncode": 1, "stderr": "no space left on device", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 1, "stderr": "no space left on device", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 1, "stderr": "no space left on device", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 1, "stderr": "no space left on device", "stdout": ""})(),
        ]

        image, status, error = choose_pullable_image_reference(
            RepositoryCandidate("project", "alice", "image", 1, ""),
            config=TEST_CONFIG,
        )

        self.assertIsNone(image)
        self.assertEqual(status, "disk_full")
        self.assertIn("no space left on device", error)
        self.assertEqual(run_command_mock.call_count, 7)
        self.assertEqual(run_command_mock.call_args_list[1].args[0], ["docker", "image", "rm", "-f", "alice/project:1"])
        self.assertEqual(cleanup_docker_storage_mock.call_count, 3)
        sleep_mock.assert_not_called()

    def test_extract_image_parts_supports_full_repo_name(self) -> None:
        namespace, name = extract_image_parts(
            {
                "repo_name": "glebos/analytics-dash",
                "repo_owner": "",
                "is_official": False,
            }
        )

        self.assertEqual((namespace, name), ("glebos", "analytics-dash"))

    @patch("docker_hub_env_finder.fetch_search_page")
    def test_filters_by_pull_count_and_limits_results(self, fetch_search_page) -> None:
        fetch_search_page.side_effect = [
            {
                "results": [
                    {
                        "repo_name": "small-app",
                        "repo_owner": "alice",
                        "pull_count": 42,
                        "repo_type": "image",
                        "short_description": "small",
                    },
                    {
                        "repo_name": "popular-app",
                        "repo_owner": "bob",
                        "pull_count": 5000,
                        "repo_type": "image",
                        "short_description": "big",
                    },
                    {
                        "repo_name": "tiny-app",
                        "repo_owner": "carol",
                        "pull_count": 7,
                        "repo_type": "image",
                        "short_description": "tiny",
                    },
                ]
            }
        ]

        results = search_repositories(query="app", max_pulls=500, max_results=2, page_size=100, max_pages=5)

        self.assertEqual(
            results,
            [
                RepositoryCandidate(
                    name="small-app",
                    namespace="alice",
                    repository_type="image",
                    pull_count=42,
                    description="small",
                ),
                RepositoryCandidate(
                    name="tiny-app",
                    namespace="carol",
                    repository_type="image",
                    pull_count=7,
                    description="tiny",
                ),
            ],
        )

    @patch("docker_hub_env_finder.fetch_search_page")
    def test_search_repositories_starts_from_requested_page(self, fetch_search_page) -> None:
        fetch_search_page.return_value = {"next": "", "results": []}
        stderr = io.StringIO()

        with patch("sys.stderr", new=stderr):
            search_repositories(
                query="app",
                max_pulls=500,
                max_results=2,
                page_size=100,
                max_pages=5,
                start_page=3,
            )

        self.assertEqual(fetch_search_page.call_args.kwargs["page"], 3)
        self.assertIn("Fetching Docker Hub search page 3 for query 'app'", stderr.getvalue())

    @patch("docker_hub_env_finder.fetch_search_page")
    def test_stops_when_docker_hub_reports_no_next_page(self, fetch_search_page) -> None:
        fetch_search_page.return_value = {
            "next": "",
            "results": [
                {
                    "repo_name": "popular-app",
                    "repo_owner": "bob",
                    "pull_count": 5000,
                    "repo_type": "image",
                    "short_description": "big",
                }
            ],
        }

        results = search_repositories(query="app", max_pulls=500, max_results=2, page_size=100, max_pages=5)

        self.assertEqual(results, [])
        self.assertEqual(fetch_search_page.call_count, 1)

    @patch("docker_hub_env_finder.fetch_search_page")
    def test_collect_unprocessed_candidates_keeps_fetching_until_max_results(self, fetch_search_page) -> None:
        fetch_search_page.side_effect = [
            {
                "next": "page2",
                "results": [
                    {"repo_name": "alice/one", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
                    {"repo_name": "alice/two", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
                ],
            },
            {
                "next": "",
                "results": [
                    {"repo_name": "alice/three", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
                    {"repo_name": "alice/four", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
                ],
            },
        ]

        with tempfile.TemporaryDirectory() as tmp_dir:
            config = AppConfig(Path(tmp_dir) / "state.db", 1, None, [])
            init_db(config)
            mark_image_processed(config, "alice/one")
            mark_image_processed(config, "alice/two")

            results = collect_unprocessed_candidates(
                config=config,
                query="alice",
                user_images=None,
                max_pulls=500,
                max_results=2,
                page_size=2,
                max_pages=5,
                start_page=1,
                start_from_index=1,
                start_from_image=None,
                ignore_db=False,
                insecure=False,
            )

        self.assertEqual([item.image for item in results], ["alice/three", "alice/four"])

    @patch("docker_hub_env_finder.fetch_namespace_repositories_page")
    def test_collect_unprocessed_candidates_supports_user_images_mode(self, fetch_namespace_repositories_page_mock) -> None:
        fetch_namespace_repositories_page_mock.side_effect = [
            {
                "next": "page2",
                "results": [
                    {"name": "one", "namespace": "alice", "pull_count": 1, "repository_type": "image", "description": ""},
                    {"name": "two", "namespace": "alice", "pull_count": 1, "repository_type": "image", "description": ""},
                ],
            },
            {
                "next": "",
                "results": [
                    {"name": "three", "namespace": "alice", "pull_count": 1, "repository_type": "image", "description": ""},
                ],
            },
        ]

        with tempfile.TemporaryDirectory() as tmp_dir:
            config = AppConfig(Path(tmp_dir) / "state.db", 1, None, [])
            init_db(config)
            mark_image_processed(config, "alice/one")

            results = collect_unprocessed_candidates(
                config=config,
                query=None,
                user_images="alice",
                max_pulls=500,
                max_results=2,
                page_size=2,
                max_pages=5,
                start_page=1,
                start_from_index=1,
                start_from_image=None,
                ignore_db=False,
                insecure=False,
            )

        self.assertEqual([item.image for item in results], ["alice/two", "alice/three"])

    @patch("docker_hub_env_finder.fetch_namespace_repositories_page")
    def test_list_namespace_repositories_prints_page_progress(self, fetch_namespace_repositories_page_mock) -> None:
        fetch_namespace_repositories_page_mock.return_value = {"next": "", "results": []}
        stderr = io.StringIO()

        with patch("sys.stderr", new=stderr):
            list_namespace_repositories(
                namespace="alice",
                max_pulls=500,
                max_results=10,
                page_size=100,
                max_pages=5,
                start_page=2,
            )

        self.assertIn("Fetching Docker Hub namespace page 2 for 'alice'", stderr.getvalue())

    @patch("docker_hub_env_finder.fetch_search_page")
    def test_collect_unprocessed_candidates_can_ignore_db_for_query_mode(self, fetch_search_page) -> None:
        fetch_search_page.return_value = {
            "next": "",
            "results": [
                {"repo_name": "alice/one", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
                {"repo_name": "alice/two", "repo_owner": "", "pull_count": 1, "repo_type": "image", "short_description": ""},
            ],
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            config = AppConfig(Path(tmp_dir) / "state.db", 1, None, [])
            init_db(config)
            mark_image_processed(config, "alice/one")

            results = collect_unprocessed_candidates(
                config=config,
                query="alice",
                user_images=None,
                max_pulls=500,
                max_results=2,
                page_size=2,
                max_pages=5,
                start_page=1,
                start_from_index=1,
                start_from_image=None,
                ignore_db=True,
                insecure=False,
            )

        self.assertEqual([item.image for item in results], ["alice/one", "alice/two"])


class SaveReportTests(BaseStatefulTests):
    def test_save_report_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "report.json"
            save_report(
                [
                    ScanResult(
                        image="library/nginx",
                        pull_count=10,
                        temp_dir=None,
                        files_copied=True,
                        env_found=False,
                        status="ok",
                    )
                ],
                str(report_path),
            )

            payload = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(payload[0]["image"], "library/nginx")

    def test_save_report_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "report.csv"
            save_report(
                [
                    ScanResult(
                        image="library/nginx",
                        pull_count=10,
                        temp_dir=None,
                        files_copied=True,
                        env_found=False,
                        status="ok",
                    )
                ],
                str(report_path),
            )

            with report_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["status"], "ok")


class DatabaseTests(BaseStatefulTests):
    def test_db_marks_and_filters_processed_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = AppConfig(Path(tmp_dir) / "state.db", 1, None, [])
            init_db(config)
            mark_image_processed(config, "alice/one", found_sensitive_files=True)

            self.assertTrue(is_image_processed(config, "alice/one"))
            self.assertFalse(is_image_processed(config, "alice/two"))

            candidates = [
                RepositoryCandidate("one", "alice", "image", 1, ""),
                RepositoryCandidate("two", "alice", "image", 1, ""),
            ]
            filtered = filter_unprocessed_candidates(config, candidates)
            self.assertEqual([item.image for item in filtered], ["alice/two"])

            with sqlite3.connect(config.db_path) as conn:
                row = conn.execute(
                    "SELECT image, found_sensitive_files FROM processed_images WHERE image = ?",
                    ("alice/one",),
                ).fetchone()
            self.assertEqual(row, ("alice/one", 1))

    def test_should_mark_processed_only_after_pull_stage(self) -> None:
        self.assertTrue(should_mark_processed(ScanResult("alice/one", 1, None, False, False, "create_failed")))
        self.assertFalse(should_mark_processed(ScanResult("alice/one", 1, None, False, False, "pull_failed")))


class ScanRepositoriesTests(BaseStatefulTests):
    @patch("docker_hub_env_finder.scan_repository")
    def test_parallel_scan_preserves_input_order(self, scan_repository_mock) -> None:
        candidates = [
            RepositoryCandidate("first", "alice", "image", 1, ""),
            RepositoryCandidate("second", "bob", "image", 2, ""),
        ]

        scan_repository_mock.side_effect = [
            ScanResult("alice/first", 1, None, True, False, "ok"),
            ScanResult("bob/second", 2, None, True, True, "ok"),
        ]

        results = scan_repositories(
            candidates,
            start_timeout=0.1,
            keep_temp=False,
            workers=2,
            result_dir=Path("/tmp/result"),
            config=TEST_CONFIG,
            ignore_db=False,
            insecure=False,
        )

        self.assertEqual([item.image for item in results], ["alice/first", "bob/second"])

    @patch("docker_hub_env_finder.scan_repository")
    def test_sequential_scan_prints_progress(self, scan_repository_mock) -> None:
        candidates = [RepositoryCandidate("first", "alice", "image", 1, "")]
        scan_repository_mock.return_value = ScanResult("alice/first:1.0.0", 1, None, True, False, "ok")
        stderr = io.StringIO()

        with patch("sys.stderr", new=stderr):
            scan_repositories(
                candidates,
                start_timeout=0.1,
                keep_temp=False,
                workers=1,
                result_dir=Path("/tmp/result"),
                config=TEST_CONFIG,
                ignore_db=False,
                insecure=False,
            )

        self.assertIn("Processed 1/1: alice/first:1.0.0 [ok]", stderr.getvalue())

    @patch("docker_hub_env_finder.scan_repository")
    def test_sequential_scan_continues_after_disk_full(self, scan_repository_mock) -> None:
        candidates = [
            RepositoryCandidate("first", "alice", "image", 1, ""),
            RepositoryCandidate("second", "bob", "image", 1, ""),
        ]
        scan_repository_mock.side_effect = [
            ScanResult("alice/first", 1, None, False, False, "disk_full", error="no space left on device"),
            ScanResult("bob/second", 1, None, True, False, "ok"),
        ]

        results = scan_repositories(
            candidates,
            start_timeout=0.1,
            keep_temp=False,
            workers=1,
            result_dir=Path("/tmp/result"),
            config=TEST_CONFIG,
            ignore_db=False,
            insecure=False,
        )

        self.assertEqual([item.status for item in results], ["disk_full", "ok"])
        self.assertEqual(scan_repository_mock.call_count, 2)

    @patch("docker_hub_env_finder.mark_image_processed")
    @patch("docker_hub_env_finder.scan_repository")
    def test_scan_repositories_does_not_write_db_when_ignore_db_enabled(
        self,
        scan_repository_mock,
        mark_image_processed_mock,
    ) -> None:
        candidates = [RepositoryCandidate("first", "alice", "image", 1, "")]
        scan_repository_mock.return_value = ScanResult("alice/first", 1, None, True, False, "ok")

        results = scan_repositories(
            candidates,
            start_timeout=0.1,
            keep_temp=False,
            workers=1,
            result_dir=Path("/tmp/result"),
            config=TEST_CONFIG,
            ignore_db=True,
            insecure=False,
        )

        self.assertEqual([item.image for item in results], ["alice/first"])
        mark_image_processed_mock.assert_not_called()

class ScanRepositoryTests(BaseStatefulTests):
    @patch("docker_hub_env_finder.shutil.rmtree")
    @patch("docker_hub_env_finder.cleanup_image")
    @patch("docker_hub_env_finder.cleanup_container")
    @patch("docker_hub_env_finder.time.sleep")
    @patch("docker_hub_env_finder.copy_container_filesystem")
    @patch("docker_hub_env_finder.run_command")
    @patch("docker_hub_env_finder.choose_pullable_image_reference")
    def test_scan_repository_uses_resolved_tagged_image(
        self,
        choose_pullable_image_reference_mock,
        run_command_mock,
        copy_container_filesystem_mock,
        sleep_mock,
        cleanup_container_mock,
        cleanup_image_mock,
        rmtree_mock,
    ) -> None:
        candidate = RepositoryCandidate("1win4games", "jjjohny228", "image", 1, "")
        choose_pullable_image_reference_mock.return_value = ("jjjohny228/1win4games:32.0.0", None, None)
        run_command_mock.side_effect = [
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": "sha256:abc123\n"})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
        ]
        copy_container_filesystem_mock.return_value = (False, None, "copy failed")

        result = scan_repository(
            candidate,
            start_timeout=0.0,
            keep_temp=False,
            result_dir=Path("/tmp/result"),
            config=TEST_CONFIG,
            insecure=False,
        )

        self.assertEqual(result.image, "jjjohny228/1win4games:32.0.0")
        self.assertEqual(
            run_command_mock.call_args_list[0].args[0],
            ["docker", "create", "--label", MANAGED_CONTAINER_LABEL, "--name", unittest.mock.ANY, "jjjohny228/1win4games:32.0.0"],
        )
        self.assertEqual(run_command_mock.call_args_list[1].args[0], ["docker", "inspect", "-f", "{{.Image}}", unittest.mock.ANY])
        cleanup_image_mock.assert_called_once_with("sha256:abc123")

    def test_scan_repository_stops_before_pull_when_event_is_set(self) -> None:
        candidate = RepositoryCandidate("project", "alice", "image", 1, "")
        stop_event = threading.Event()
        stop_event.set()

        result = scan_repository(
            candidate,
            start_timeout=0.0,
            keep_temp=False,
            result_dir=Path("/tmp/result"),
            config=TEST_CONFIG,
            insecure=False,
            stop_event=stop_event,
        )

        self.assertEqual(result.status, "stopped")
        self.assertFalse(result.env_found)


class CleanupTests(BaseStatefulTests):
    @patch("docker_hub_env_finder.send_telegram_message")
    @patch("docker_hub_env_finder.run_command")
    def test_cleanup_docker_storage_only_prunes_managed_resources(
        self,
        run_command_mock,
        send_telegram_message_mock,
    ) -> None:
        _KNOWN_IMAGE_IDS.add("sha256:owned")
        run_command_mock.side_effect = [
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
            type("CP", (), {"returncode": 0, "stderr": "", "stdout": ""})(),
        ]

        cleanup_ok = cleanup_docker_storage(TEST_CONFIG)

        self.assertTrue(cleanup_ok)
        self.assertEqual(
            run_command_mock.call_args_list[0].args[0],
            ["docker", "container", "prune", "-f", "--filter", f"label={MANAGED_CONTAINER_LABEL}"],
        )
        self.assertEqual(
            run_command_mock.call_args_list[1].args[0],
            ["docker", "image", "rm", "-f", "sha256:owned"],
        )
        send_telegram_message_mock.assert_called_once()

    @patch("docker_hub_env_finder.run_command")
    def test_cleanup_image_uses_exact_image_id(self, run_command_mock) -> None:
        cleanup_image("sha256:deadbeef")

        run_command_mock.assert_called_once_with(["docker", "image", "rm", "-f", "sha256:deadbeef"], check=False)

    @patch("docker_hub_env_finder.run_command")
    def test_cleanup_image_waits_for_last_user(self, run_command_mock) -> None:
        _IMAGE_USAGE_COUNTS["sha256:shared"] = 2

        cleanup_image("sha256:shared")
        cleanup_image("sha256:shared")

        self.assertEqual(run_command_mock.call_count, 1)
        run_command_mock.assert_called_once_with(["docker", "image", "rm", "-f", "sha256:shared"], check=False)


if __name__ == "__main__":
    unittest.main()
