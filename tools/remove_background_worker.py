import argparse
import json
import sys
from pathlib import Path

from layer_image import parse_focus_box
from rembg import new_session

from remove_background import build_remove_background_result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent background-removal worker.")
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
            output_path = str(payload.get("output") or "").strip()
            meta_output = str(payload.get("meta_output") or "").strip()
            if not input_path or not output_path or not meta_output:
                raise ValueError("input/output is required")

            focus_box_payload = payload.get("focus_box")
            focus_box = None
            if isinstance(focus_box_payload, dict):
                focus_box = parse_focus_box(
                    focus_box_payload.get("left"),
                    focus_box_payload.get("top"),
                    focus_box_payload.get("right"),
                    focus_box_payload.get("bottom"),
                )

            source = Path(input_path).read_bytes()
            result = build_remove_background_result(source, session, focus_box)
            Path(output_path).write_bytes(result["image"])
            Path(meta_output).write_text(json.dumps(result["meta"], ensure_ascii=False), encoding="utf-8")
            write_message({"ok": True})
        except Exception as error:  # noqa: BLE001
            write_message({"ok": False, "error": str(error)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
