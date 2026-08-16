import os
import torch
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

# ── Configuration ─────────────────────────────────────────────────────────────
MAX_SEQ_LENGTH = 2048
LOAD_IN_4BIT = True
DATASET_FILE = os.path.join(os.path.dirname(__file__), "qwen_dataset_filled.jsonl")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "qwen_outlines_lora")
ADAPTER_DIR = os.path.join(os.path.dirname(__file__), "qwen_outlines_adapter")

# ── Load base model & tokenizer ───────────────────────────────────────────────
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen2.5-7B-Instruct",
    max_seq_length=MAX_SEQ_LENGTH,
    dtype=None,  # auto-detect float16 / bfloat16
    load_in_4bit=LOAD_IN_4BIT,
)

# ── Add LoRA adapters ─────────────────────────────────────────────────────────
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

# ── Format dataset with Qwen ChatML prompt template ───────────────────────────
PROMPT_TEMPLATE = (
    "<|im_start|>user\n"
    "{instruction}\n\n"
    "Outline:\n{input}<|im_end|>\n"
    "<|im_start|>assistant\n"
    "{output}<|im_end|>"
)


def format_prompts(examples):
    texts = []
    for inst, inp, outp in zip(
        examples["instruction"], examples["input"], examples["output"]
    ):
        text = PROMPT_TEMPLATE.format(
            instruction=inst, input=inp, output=outp
        ) + tokenizer.eos_token
        texts.append(text)
    return {"text": texts}


dataset = load_dataset("json", data_files=DATASET_FILE, split="train")
dataset = dataset.map(format_prompts, batched=True)

# ── Fine-tune ─────────────────────────────────────────────────────────────────
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=MAX_SEQ_LENGTH,
    dataset_num_proc=2,
    packing=False,
    args=TrainingArguments(
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        warmup_steps=10,
        max_steps=120,
        learning_rate=2e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=1,
        optim="adamw_8bit",
        output_dir=OUTPUT_DIR,
    ),
)

trainer.train()

# ── Save fine-tuned adapter ───────────────────────────────────────────────────
model.save_pretrained(ADAPTER_DIR)
tokenizer.save_pretrained(ADAPTER_DIR)
print(f"Training complete. Adapter saved to {ADAPTER_DIR}")




