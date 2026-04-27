import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from download_r2_bucket import download_bucket


class DownloadBucketTests(unittest.TestCase):
    @patch("download_r2_bucket.build_r2_client")
    @patch("download_r2_bucket.parse_env")
    def test_download_bucket_deletes_objects_after_successful_download(
        self,
        parse_env_mock,
        build_r2_client_mock,
    ) -> None:
        parse_env_mock.side_effect = lambda name, default="": {
            "R2_BUCKET_NAME": "bucket",
            "R2_BUCKET_PREFIX": "findings",
        }.get(name, default)

        client = build_r2_client_mock.return_value
        client.list_objects_v2.return_value = {
            "Contents": [{"Key": "findings/folder/.env"}],
            "IsTruncated": False,
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            downloaded = download_bucket(Path(tmp_dir))

        self.assertEqual(downloaded, 1)
        client.download_file.assert_called_once_with("bucket", "findings/folder/.env", unittest.mock.ANY)
        client.delete_object.assert_called_once_with(Bucket="bucket", Key="findings/folder/.env")

    @patch("download_r2_bucket.build_r2_client")
    @patch("download_r2_bucket.parse_env")
    def test_download_bucket_deletes_objects_without_extra_flag(
        self,
        parse_env_mock,
        build_r2_client_mock,
    ) -> None:
        parse_env_mock.side_effect = lambda name, default="": {
            "R2_BUCKET_NAME": "bucket",
            "R2_BUCKET_PREFIX": "",
        }.get(name, default)

        client = build_r2_client_mock.return_value
        client.list_objects_v2.return_value = {
            "Contents": [{"Key": "folder/.env"}],
            "IsTruncated": False,
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            downloaded = download_bucket(Path(tmp_dir))

        self.assertEqual(downloaded, 1)
        client.download_file.assert_called_once_with("bucket", "folder/.env", unittest.mock.ANY)
        client.delete_object.assert_called_once_with(Bucket="bucket", Key="folder/.env")


if __name__ == "__main__":
    unittest.main()
