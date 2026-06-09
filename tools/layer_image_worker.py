import argparse
import json
import sys
from pathlib import Path

from layer_image import build_layer_result
from rembg import new_session


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent smart-layer worker.")
    parser.add_argument("--model", default="u2netp", help="rembg model name")
    return parser.parse_args()


def write_message(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    args = parse_args()
    session = new_session(args.model)
    write_message({"ready": True})

    for line in sys.stdin:
        payload_text = line.strip()
        if not payload_text:
            continue
        try:
            payload = json.loads(payload_text)
            input_path = str(payload.get("input") or "").strip()
            background_output = str(payload.get("background_output") or "").strip()
            product_output = str(payload.get("product_output") or "").strip()
            meta_output = str(payload.get("meta_output") or "").strip()
            if not input_path or not background_output or not product_output or not meta_output:
                raise ValueError("input/background_output/product_output/meta_output is required")

            result = build_layer_result(Path(input_path).read_bytes(), session)
            Path(background_output).write_bytes(result["background"])
            Path(product_output).write_bytes(result["product"])
            Path(meta_output).write_text(json.dumps(result["meta"], ensure_ascii=False), encoding="utf-8")
            write_message({"ok": True})
        except Exception as error:  # noqa: BLE001
            write_message({"ok": False, "error": str(error)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
