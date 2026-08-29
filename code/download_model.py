"""Pre-cache a Hugging Face model's files without loading it into memory.

Both generation (transformers) and embedding (sentence-transformers) models are
plain Hugging Face Hub repos, so a single snapshot download works for either —
this only warms the local cache; it never instantiates the model.
"""

import argparse

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-name", required=True)
    args = parser.parse_args()

    print(f"Downloading {args.model_name} into the local Hugging Face cache...")
    path = snapshot_download(repo_id=args.model_name)
    print(f"Done. Cached at: {path}")


if __name__ == "__main__":
    main()
