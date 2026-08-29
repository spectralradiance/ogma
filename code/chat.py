"""
Interactive chat with Qwen 2.5 7B Instruct, optionally RAG-augmented.

Conversation history is saved to chat_history.json and reloaded on startup
so sessions persist across runs.

Usage:
    python chat.py [--db-dir PATH] [--top-k N] [--no-rag]

Commands during chat:
    /quit or /exit   — end the session
    /clear           — wipe conversation history and start fresh
    /history         — print the current conversation
    /save [file]     — export conversation to a markdown file
"""

import argparse
import json
import os
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

import write_book

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, "data")
INTERMEDIARY_DIR = os.path.join(DATA_DIR, "intermediary")
OUTPUT_DIR = os.path.join(DATA_DIR, "output")
HISTORY_FILE = os.path.join(INTERMEDIARY_DIR, "chat_history.json")
DEFAULT_DB_DIR = os.path.join(INTERMEDIARY_DIR, "chroma_db")
COLLECTION_NAME = "notes"
MAX_SEQ_LENGTH = 4096
MAX_NEW_TOKENS = 768
TOP_K = 4

SYSTEM_PROMPT = write_book.GUIDANCE["chat"]["system"]


# ---------------------------------------------------------------------------
# History helpers
# ---------------------------------------------------------------------------

def load_history() -> list[dict]:
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return []


def save_history(history: list[dict]) -> None:
    os.makedirs(INTERMEDIARY_DIR, exist_ok=True)
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def export_history(history: list[dict], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for msg in history:
            role = msg["role"].capitalize()
            f.write(f"**{role}:** {msg['content']}\n\n")
    print(f"Saved to {path}")


def print_history(history: list[dict]) -> None:
    if not history:
        print("(no history)")
        return
    for msg in history:
        prefix = "You" if msg["role"] == "user" else "Assistant"
        print(f"\n[{prefix}]\n{msg['content']}")
    print()


# ---------------------------------------------------------------------------
# RAG helpers
# ---------------------------------------------------------------------------

def load_collection(db_dir: str):
    try:
        import chromadb
        from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    except ImportError:
        return None
    if not os.path.isdir(db_dir):
        return None
    ef = SentenceTransformerEmbeddingFunction(model_name=write_book.EMBEDDING_MODEL)
    client = chromadb.PersistentClient(path=db_dir)
    try:
        return client.get_collection(name=COLLECTION_NAME, embedding_function=ef)
    except Exception:
        return None


def retrieve_context(collection, query: str, k: int) -> str:
    results = collection.query(query_texts=[query], n_results=k, include=["documents", "metadatas"])
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    if not docs:
        return ""
    excerpts = []
    for doc, meta in zip(docs, metas):
        source = meta.get("filename", "note")
        excerpts.append(f"[{source}]\n{doc.strip()}")
    return "\n\n---\n\n".join(excerpts)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def build_messages(history: list[dict], user_query: str, context: str) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)

    content = user_query
    if context:
        content = (
            f"Relevant source material:\n\n{context}\n\n"
            f"---\n\nQuestion: {user_query}"
        )
    messages.append({"role": "user", "content": content})
    return messages


def build_model_input(history: list[dict], user_query: str, context: str, tokenizer) -> str:
    messages = build_messages(history, user_query, context)
    return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def generate(model, tokenizer, text: str) -> str:
    device = next(model.parameters()).device
    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=MAX_SEQ_LENGTH - MAX_NEW_TOKENS,
    ).to(device)

    with torch.no_grad():
        output = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            repetition_penalty=1.1,
            pad_token_id=tokenizer.eos_token_id,
        )

    input_len = inputs["input_ids"].shape[1]
    return tokenizer.decode(output[0][input_len:], skip_special_tokens=True).strip()


def respond(provider: str, model_name: str, model, tokenizer, history: list[dict], user_query: str, context: str) -> str:
    messages = build_messages(history, user_query, context)
    if provider == "claude":
        return write_book.generate_claude_text(model_name, messages, MAX_NEW_TOKENS, do_sample=True)
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return generate(model, tokenizer, prompt_text)


def _load_model(model_name: str, device: str):
    """Try 4-bit NF4 → float16 → bfloat16 CPU, logging which path succeeds."""
    if device == "cuda":
        for label, kwargs in [
            ("4-bit NF4", dict(
                quantization_config=BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                    bnb_4bit_compute_dtype=torch.bfloat16,
                ),
                device_map="auto",
            )),
            ("float16", dict(
                torch_dtype=torch.float16,
                device_map="auto",
            )),
        ]:
            try:
                print(f"  Trying {label}...")
                model = AutoModelForCausalLM.from_pretrained(
                    model_name, trust_remote_code=True, **kwargs
                )
                print(f"  Loaded with {label}")
                return model
            except Exception as exc:
                print(f"  {label} failed: {exc}")
        print("  CUDA loading failed — falling back to CPU bfloat16 (slow)")

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    return model.to("cpu")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    global HISTORY_FILE, OUTPUT_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-dir", default=DEFAULT_DB_DIR)
    parser.add_argument("--top-k", type=int, default=TOP_K)
    parser.add_argument("--no-rag", action="store_true", help="Disable RAG context retrieval")
    parser.add_argument("--history-file", default=HISTORY_FILE)
    parser.add_argument("--output-dir", default=OUTPUT_DIR)
    parser.add_argument("--allow-cpu", action="store_true")
    parser.add_argument("--provider", choices=("local", "claude"), default="local")
    parser.add_argument("--model-name", default="Qwen/Qwen2.5-7B-Instruct")
    parser.add_argument(
        "--message", default=None,
        help="If set, answer this one message non-interactively (for the web chat) instead of "
             "starting the terminal REPL. History is still loaded from/saved to --history-file.",
    )
    args = parser.parse_args()

    HISTORY_FILE = os.path.abspath(args.history_file)
    OUTPUT_DIR = os.path.abspath(args.output_dir)
    os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    provider = "claude" if write_book.is_claude_model(args.model_name) else args.provider
    model_name = args.model_name

    # Load RAG collection
    collection = None
    if not args.no_rag:
        collection = load_collection(os.path.normpath(args.db_dir))
        if collection:
            print(f"RAG enabled — {collection.count()} chunks available")
        else:
            print("RAG disabled — ChromaDB store not found (run index_notes.py first)")

    # Load model (Claude has no local weights to load)
    model = tokenizer = None
    if provider == "claude":
        write_book.load_project_env()
        print(f"Using Claude API ({model_name}). Notes stay local; only retrieved excerpts are sent.")
    else:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading {model_name} on {device}...")
        tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
        model = write_book._load_model(model_name, device, allow_cpu=args.allow_cpu)
        write_book.ensure_generation_device(model, args.allow_cpu)
        model.eval()
    print("Model ready.")

    history = load_history()

    if args.message is not None:
        context = ""
        if collection and not args.no_rag:
            context = retrieve_context(collection, args.message, args.top_k)
        response = respond(provider, model_name, model, tokenizer, history, args.message, context)
        history.append({"role": "user", "content": args.message})
        history.append({"role": "assistant", "content": response})
        save_history(history)
        print(json.dumps({"response": response}))
        return

    print("Type /quit to exit, /help for commands.\n")
    if history:
        print(f"Resuming session — {len(history)} messages in history. "
              "Type /clear to start fresh.\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nExiting.")
            break

        if not user_input:
            continue

        # Commands
        if user_input.lower() in ("/quit", "/exit"):
            break
        if user_input.lower() == "/clear":
            history = []
            save_history(history)
            print("History cleared.\n")
            continue
        if user_input.lower() == "/history":
            print_history(history)
            continue
        if user_input.lower().startswith("/save"):
            parts = user_input.split(maxsplit=1)
            os.makedirs(OUTPUT_DIR, exist_ok=True)
            path = parts[1] if len(parts) > 1 else os.path.join(OUTPUT_DIR, "chat_export.md")
            export_history(history, path)
            continue
        if user_input.lower() == "/help":
            print(
                "/clear       — erase conversation history\n"
                "/history     — print conversation so far\n"
                "/save [file] — export conversation to markdown\n"
                "/quit        — exit\n"
            )
            continue

        # Retrieve context
        context = ""
        if collection and not args.no_rag:
            context = retrieve_context(collection, user_input, args.top_k)

        # Generate
        response = respond(provider, model_name, model, tokenizer, history, user_input, context)

        print(f"\nAssistant: {response}\n")

        # Persist turn — store the bare user query (not the RAG-augmented version)
        history.append({"role": "user", "content": user_input})
        history.append({"role": "assistant", "content": response})
        save_history(history)

    save_history(history)
    print("Conversation saved.")


if __name__ == "__main__":
    main()
