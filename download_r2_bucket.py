import argparse
import os
from pathlib import Path

import boto3

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv() -> bool:
        return False


def parse_env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default)).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download all files from a Cloudflare R2 bucket using environment configuration."
    )
    parser.add_argument(
        "--output-dir",
        default="r2_downloads",
        help="Local directory where files will be downloaded. Default: r2_downloads.",
    )
    parser.add_argument(
        "--prefix",
        help="Optional override for R2_BUCKET_PREFIX from environment.",
    )
    return parser.parse_args()


def build_r2_client():
    load_dotenv()

    endpoint_url = parse_env("R2_ENDPOINT_URL")
    access_key_id = parse_env("R2_ACCESS_KEY_ID")
    secret_access_key = parse_env("R2_SECRET_ACCESS_KEY")

    missing = [
        name
        for name, value in {
            "R2_ENDPOINT_URL": endpoint_url,
            "R2_ACCESS_KEY_ID": access_key_id,
            "R2_SECRET_ACCESS_KEY": secret_access_key,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    session = boto3.session.Session()
    return session.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
    )


def iter_bucket_keys(client, bucket_name: str, prefix: str):
    continuation_token = None
    while True:
        params = {"Bucket": bucket_name, "Prefix": prefix}
        if continuation_token:
            params["ContinuationToken"] = continuation_token

        response = client.list_objects_v2(**params)
        for item in response.get("Contents", []):
            key = item["Key"]
            if key.endswith("/"):
                continue
            yield key

        if not response.get("IsTruncated"):
            break
        continuation_token = response.get("NextContinuationToken")


def download_bucket(output_dir: Path, prefix_override: str | None = None) -> int:
    load_dotenv()

    bucket_name = parse_env("R2_BUCKET_NAME")
    prefix = prefix_override if prefix_override is not None else parse_env("R2_BUCKET_PREFIX")
    prefix = prefix.strip("/")
    prefix_filter = f"{prefix}/" if prefix else ""

    if not bucket_name:
        raise RuntimeError("Missing required environment variable: R2_BUCKET_NAME")

    client = build_r2_client()
    output_dir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    for key in iter_bucket_keys(client, bucket_name, prefix_filter):
        relative_key = key[len(prefix_filter):] if prefix_filter and key.startswith(prefix_filter) else key
        target_path = output_dir / relative_key
        target_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {key} -> {target_path}")
        client.download_file(bucket_name, key, str(target_path))
        downloaded += 1

    return downloaded


def main() -> int:
    args = parse_args()
    try:
        downloaded = download_bucket(Path(args.output_dir), prefix_override=args.prefix)
    except Exception as exc:
        print(f"Download failed: {exc}")
        return 1

    print(f"Downloaded {downloaded} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
