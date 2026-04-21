import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docker_hub_env_finder import (
    _IMAGE_USAGE_COUNTS,
    calculate_page_offset,
    calculate_start_page,
    choose_pullable_image_reference,
    classify_pull_error,
    copy_found_files,
    RepositoryCandidate,
    ScanResult,
    cleanup_image,
    contains_env_file,
    copy_found_env,
    extract_image_parts,
    find_env_file,
    find_sensitive_files,
    get_image_references,
    make_safe_image_name,
    save_report,
    scan_repository,
    scan_repositories,
    search_repositories,
    slice_candidates,
)


class ContainsEnvFileTests(unittest.TestCase):
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

            matches = find_sensitive_files(root)

            self.assertEqual(
                [path.name for path in matches],
                [".env.production", "config.json"],
            )

    def test_returns_false_when_env_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "app").mkdir()

            self.assertFalse(contains_env_file(root))
            self.assertIsNone(find_env_file(root))


class ResultFileTests(unittest.TestCase):
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

    def test_copy_found_files_preserves_relative_paths_under_image_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            scan_root = root / "scan"
            config_dir = scan_root / "app" / "config"
            config_dir.mkdir(parents=True)
            first = config_dir / ".env.local"
            second = scan_root / "settings.py"
            first.write_text("KEY=VALUE", encoding="utf-8")
            second.write_text("DEBUG=False", encoding="utf-8")

            saved = copy_found_files([first, second], scan_root, root / "result", "alice/project:latest")

            self.assertEqual(
                saved,
                [
                    root / "result" / "alice_project_latest" / "app" / "config" / ".env.local",
                    root / "result" / "alice_project_latest" / "settings.py",
                ],
            )

    def test_classify_pull_error_for_legacy_manifest(self) -> None:
        error = (
            'Error response from daemon: not implemented: media type '
            '"application/vnd.docker.distribution.manifest.v1+prettyjws" '
            "is no longer supported since containerd v2.1"
        )

        self.assertEqual(classify_pull_error(error), "unsupported_manifest")


class SearchRepositoriesTests(unittest.TestCase):
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
            RepositoryCandidate("1win4games", "jjjohny228", "image", 1, "")
        )

        self.assertEqual(image, "jjjohny228/1win4games:31.0.0")
        self.assertIsNone(status)
        self.assertIsNone(error)

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

        search_repositories(
            query="app",
            max_pulls=500,
            max_results=2,
            page_size=100,
            max_pages=5,
            start_page=3,
        )

        self.assertEqual(fetch_search_page.call_args.kwargs["page"], 3)

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


class SaveReportTests(unittest.TestCase):
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
            self.assertEqual(rows[0]["matched_files"], "[]")


class ScanRepositoriesTests(unittest.TestCase):
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
                insecure=False,
            )

        self.assertIn("Processed 1/1: alice/first:1.0.0 [ok]", stderr.getvalue())

class ScanRepositoryTests(unittest.TestCase):
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
            insecure=False,
        )

        self.assertEqual(result.image, "jjjohny228/1win4games:32.0.0")
        self.assertEqual(run_command_mock.call_args_list[0].args[0], ["docker", "create", "--name", unittest.mock.ANY, "jjjohny228/1win4games:32.0.0"])
        self.assertEqual(run_command_mock.call_args_list[1].args[0], ["docker", "inspect", "-f", "{{.Image}}", unittest.mock.ANY])
        cleanup_image_mock.assert_called_once_with("sha256:abc123")


class CleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        _IMAGE_USAGE_COUNTS.clear()

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
