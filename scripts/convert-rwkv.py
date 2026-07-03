#!/usr/bin/env python3
"""Convert RWKV v7 .pth checkpoint to web-rwkv safetensors format.

Usage:
  python scripts/convert-rwkv.py --input models/rwkv7-g1h.pth --output models/rwkv7-g1h.st
"""

import argparse
import sys
from pathlib import Path

import torch
from safetensors.torch import save_file


RENAME = {
    "time_faaaa": "time_first",
    "time_maa": "time_mix",
    "lora_A": "lora.0",
    "lora_B": "lora.1",
}

TRANSPOSE = [
    "time_mix_w1", "time_mix_w2", "time_decay_w1", "time_decay_w2",
    "w1", "w2", "a1", "a2", "g1", "g2", "v1", "v2",
    "time_state", "lora.0",
]


def convert_file(pt_path: str, st_path: str, half: bool = True) -> None:
    print(f"Loading {pt_path} ...", file=sys.stderr)
    loaded = torch.load(pt_path, map_location="cpu", weights_only=True)
    if "state_dict" in loaded:
        loaded = loaded["state_dict"]

    output = {}
    for k, v in loaded.items():
        new_k = k.lower()
        for old, new in RENAME.items():
            if old in new_k:
                new_k = new_k.replace(old, new)
        if half:
            v = v.half()
        # Transpose matrices matching web-rwkv expected layout
        for pattern in TRANSPOSE:
            if pattern in new_k and v.dim() >= 2:
                v = v.transpose(-2, -1).contiguous()
                break
        else:
            v = v.contiguous()
        # Squeeze [1,1,D] vectors to [D] for web-rwkv compatibility
        while v.dim() > 1 and v.shape[0] == 1 and v.shape[1] == 1:
            v = v.squeeze()
        print(f"  {new_k}  {list(v.shape)}  {v.dtype}", file=sys.stderr)
        output[new_k] = v

    Path(st_path).parent.mkdir(parents=True, exist_ok=True)
    save_file(output, st_path)
    print(f"Saved to {st_path} ({len(output)} tensors)", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert RWKV v7 .pth to web-rwkv .st")
    parser.add_argument("--input", "-i", required=True, help="Input .pth file path")
    parser.add_argument("--output", "-o", default=None, help="Output .st file path (default: input .st)")
    parser.add_argument("--no-half", action="store_true", help="Keep bf16 (default: convert to f16)")
    args = parser.parse_args()

    if args.output is None:
        args.output = Path(args.input).with_suffix(".st")

    convert_file(args.input, str(args.output), half=not args.no_half)


if __name__ == "__main__":
    main()
