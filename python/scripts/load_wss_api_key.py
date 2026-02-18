#!/usr/bin/env python3

import argparse
import os
import random
import sys
import time
import boto3
from typing import List, Optional
from botocore.exceptions import ClientError

import pylib as keyme
from control_panel.shared import WSS_SECRET_ID
from control_panel.python.shared import WSS_KEYRING_SERVICE, WSS_KEYRING_USERNAME

def _ensure_repo_on_syspath():
    # Allow running as a script without needing PYTHONPATH=/kiosk.
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
_ensure_repo_on_syspath()

def load_wss_api_key(
    *,
    keyring_service: str = WSS_KEYRING_SERVICE,
    keyring_username: str = WSS_KEYRING_USERNAME,
    secret_id: str = WSS_SECRET_ID,
    region_name: str = "us-east-1",
    max_retries: int = 5,
    base_delay_seconds: float = 2.0,
    enable_jitter: bool = True,
    cache_in_keyring: bool = True,
) -> Optional[str]:
    """Load WSS API key from keyring or AWS Secrets Manager.

    - If present in keyring, returns it immediately.
    - Otherwise, attempts to fetch from Secrets Manager and (optionally) cache into keyring.
    - Returns None if not available.
    """
    api_key = keyme.keyring_utils.safe_get_password(keyring_service, keyring_username)
    if api_key:
        keyme.log.info("WSS API key found in keyring")
        return api_key

    keyme.log.warning("WSS API key not in keyring, fetching from AWS Secrets Manager")
    if boto3 is None:
        keyme.log.error("boto3 not available, cannot fetch WSS API key")
        return None

    if enable_jitter:
        time.sleep(random.uniform(0, 1.5))

    client = boto3.client("secretsmanager", region_name=region_name)
    for attempt in range(1, max_retries + 1):
        try:
            response = client.get_secret_value(SecretId=secret_id)
            secret_str = (response.get("SecretString") or "").strip()
            if not secret_str:
                raise ValueError("SecretString is empty in AWS secret")
            if cache_in_keyring:
                keyme.keyring_utils.safe_set_password(keyring_service, keyring_username, secret_str)
            return secret_str
        except ClientError as e:
            keyme.log.warning(f"WSS API key attempt {attempt} failed with ClientError: {e}")
        except Exception as e:
            keyme.log.warning(f"WSS API key attempt {attempt} failed: {e}")
        if attempt < max_retries:
            delay = base_delay_seconds * (2 ** (attempt - 1))
            if enable_jitter:
                delay += random.uniform(0, 2)
            time.sleep(delay)

    keyme.log.error("Failed to retrieve WSS API key after multiple attempts")
    return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Load and cache control-panel WSS API key into keyring.")
    parser.add_argument("--require", action="store_true", help="Exit non-zero if key cannot be loaded.")
    parser.add_argument("--no-jitter", action="store_true", help="Disable initial delay and retry jitter.")
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--base-delay-seconds", type=float, default=2.0)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--secret-id", default=WSS_SECRET_ID)
    parser.add_argument("--keyring-service", default=WSS_KEYRING_SERVICE)
    parser.add_argument("--keyring-username", default=WSS_KEYRING_USERNAME)
    args = parser.parse_args(argv)

    api_key = load_wss_api_key(
        keyring_service=args.keyring_service,
        keyring_username=args.keyring_username,
        secret_id=args.secret_id,
        region_name=args.region,
        max_retries=max(1, args.max_retries),
        base_delay_seconds=max(0.0, args.base_delay_seconds),
        enable_jitter=not args.no_jitter,
        cache_in_keyring=True,
    )

    if api_key:
        return 0
    return 1 if args.require else 0


if __name__ == "__main__":
    raise SystemExit(main())

