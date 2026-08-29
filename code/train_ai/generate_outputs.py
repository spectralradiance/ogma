"""
Use the base Qwen 2.5 7B Instruct model to generate prose output for each
outline block in qwen_dataset.jsonl, then write qwen_dataset_filled.jsonl.
Run this before train_ai.py.
"""
import json
import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GUIDANCE_FILE = os.path.join(PROJECT_DIR, "data", "input", "guidance", "guidance.json")
DATASET_FILE = os.path.join(os.path.dirname(__file__), "qwen_dataset.jsonl")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "qwen_dataset_filled.jsonl")
MAX_SEQ_LENGTH = 2048
MAX_NEW_TOKENS = 512
BATCH_SIZE = 4

with open(GUIDANCE_FILE, encoding="utf-8") as guidance_file:
    GUIDANCE = json.load(guidance_file)

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Loading model on {device}...")
tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-7B-Instruct", trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct",
    dtype=torch.float16 if device == "cuda" else torch.float32,
    device_map="auto" if device == "cuda" else None,
    trust_remote_code=True,
)
if device == "cpu":
    model = model.to("cpu")
model.eval()

SYSTEM_PROMPT = GUIDANCE["training"]["generation_system"]


def build_prompt(instruction: str, outline: str) -> str:
    return (
        "<|im_start|>system\n"
        f"{SYSTEM_PROMPT}<|im_end|>\n"
        "<|im_start|>user\n"
        f"{instruction}\n\nOutline:\n{outline}<|im_end|>\n"
        "<|im_start|>assistant\n"
    )


def generate_batch(prompts: list[str]) -> list[str]:
    inputs = tokenizer(
        prompts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=MAX_SEQ_LENGTH - MAX_NEW_TOKENS,
    ).to(device)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            temperature=1.0,
            pad_token_id=tokenizer.eos_token_id,
        )

    results = []
    for i, output in enumerate(outputs):
        # Decode only the newly generated tokens
        input_len = inputs["input_ids"].shape[1]
        new_tokens = output[input_len:]
        text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        results.append(text)
    return results


def main():
    with open(DATASET_FILE, "r", encoding="utf-8") as f:
        entries = [json.loads(line) for line in f if line.strip()]

    # Resume from existing output file if present
    done = 0
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            done = sum(1 for line in f if line.strip())
        print(f"Resuming from entry {done}")

    total = len(entries)
    print(f"Generating outputs for {total - done} entries (total {total})")

    with open(OUTPUT_FILE, "a", encoding="utf-8") as out_f:
        for batch_start in range(done, total, BATCH_SIZE):
            batch = entries[batch_start : batch_start + BATCH_SIZE]
            prompts = [
                build_prompt(e["instruction"], e["input"]) for e in batch
            ]
            generated = generate_batch(prompts)

            for entry, prose in zip(batch, generated):
                entry["output"] = prose
                out_f.write(json.dumps(entry) + "\n")

            out_f.flush()
            print(
                f"  [{batch_start + len(batch)}/{total}] "
                f"sample: {generated[0][:80]}..."
            )

    print(f"\nDone. Filled dataset saved to {OUTPUT_FILE}")
    print("Update train_ai.py to use qwen_dataset_filled.jsonl before training.")


if __name__ == "__main__":
    main()
