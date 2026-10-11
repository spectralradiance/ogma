"""Local model adapter: Hugging Face transformers on CUDA, the ogma approach.

One model at a time, loaded lazily in 4-bit NF4 (float16 fallback), CUDA only
(ogma's guard: no silent CPU offload), and unloaded after an idle timeout so
VRAM is returned. The lock is the "GPU lane": local jobs run one at a time.
"""

from __future__ import annotations

import gc
import threading
from collections.abc import Callable, Iterator
from typing import Any

from ..ai_types import GenerateRequest, Profile, ProviderError, ProviderHealth, StreamEvent, done_event, plain_text, text_event, usage_event

DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
IDLE_UNLOAD_SECONDS = 600.0
LANE_WAIT_SECONDS = 120.0


class LocalHFProvider:
    id = "local_hf"
    label = "Local (transformers)"
    kind = "local"
    supports_tools = False

    def __init__(self, torch_status: Callable[[], dict[str, Any]], idle_seconds: float = IDLE_UNLOAD_SECONDS) -> None:
        self._torch_status = torch_status
        self._idle_seconds = idle_seconds
        self._lane = threading.Lock()
        self._loaded: tuple[str, Any, Any] | None = None  # (name, model, tokenizer)
        self._idle_timer: threading.Timer | None = None

    def health(self) -> ProviderHealth:
        status = self._torch_status()
        if status.get("state") == "pending":
            return ProviderHealth(False, "checking PyTorch…")
        if status.get("error"):
            return ProviderHealth(False, "PyTorch failed to load")
        if not status.get("installed"):
            return ProviderHealth(False, "PyTorch not installed")
        if not status.get("cuda_available"):
            return ProviderHealth(False, "CUDA unavailable")
        return ProviderHealth(True)

    def loaded_models(self) -> list[str]:
        return [self._loaded[0]] if self._loaded else []

    def unload(self) -> None:
        with self._lane:
            self._unload_locked()

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        health = self.health()
        if not health.configured:
            raise ProviderError("unavailable", f"Local model unavailable: {health.detail}.")
        if not self._lane.acquire(timeout=LANE_WAIT_SECONDS):
            raise ProviderError("unavailable", "The local model is busy with another job.")
        try:
            if self._idle_timer:
                self._idle_timer.cancel()
            model, tokenizer = self._ensure_loaded(profile.model or DEFAULT_MODEL, profile.params)
            yield from self._generate(model, tokenizer, request)
        finally:
            self._schedule_unload()
            self._lane.release()

    # -- internals -------------------------------------------------------------

    def _ensure_loaded(self, name: str, params: dict[str, Any]) -> tuple[Any, Any]:
        if self._loaded and self._loaded[0] == name:
            return self._loaded[1], self._loaded[2]
        self._unload_locked()
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        attempts: list[tuple[str, dict[str, Any]]] = []
        if params.get("quant", "4bit") == "4bit":
            attempts.append(("4-bit NF4", {"quantization_config": BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
            )}))
        attempts.append(("float16", {"torch_dtype": torch.float16}))

        failures: list[str] = []
        for label, kwargs in attempts:
            try:
                model = AutoModelForCausalLM.from_pretrained(name, device_map="cuda", trust_remote_code=True, **kwargs)
            except Exception as error:  # try the next precision
                failures.append(f"{label}: {error}")
                continue
            devices = {parameter.device.type for parameter in model.parameters()}
            if devices != {"cuda"}:
                del model
                self._free_cuda()
                raise ProviderError("unavailable", f"{name} did not fit on the GPU (parts landed on {sorted(devices)}).")
            tokenizer = AutoTokenizer.from_pretrained(name, trust_remote_code=True)
            self._loaded = (name, model, tokenizer)
            return model, tokenizer
        raise ProviderError("unavailable", f"Could not load {name}. " + " | ".join(failures))

    def _generate(self, model: Any, tokenizer: Any, request: GenerateRequest) -> Iterator[StreamEvent]:
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

        messages = [{"role": "system", "content": request.system}] if request.system else []
        messages += [{"role": message.role, "content": plain_text(message)} for message in request.messages]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=300)
        cancelled = threading.Event()

        class StopWhenCancelled(StoppingCriteria):
            def __call__(self, *_args: Any, **_kwargs: Any) -> bool:
                return cancelled.is_set()

        options: dict[str, Any] = {
            **inputs,
            "max_new_tokens": request.max_tokens,
            "streamer": streamer,
            "stopping_criteria": StoppingCriteriaList([StopWhenCancelled()]),
            "pad_token_id": tokenizer.eos_token_id,
            "repetition_penalty": 1.1,
        }
        if request.temperature:
            options.update(do_sample=True, temperature=request.temperature, top_p=0.9)
        else:
            options.update(do_sample=False)

        worker = threading.Thread(target=model.generate, kwargs=options, name="local-generate", daemon=True)
        worker.start()
        try:
            for piece in streamer:
                if piece:
                    yield text_event(piece)
        finally:
            # Runs on completion and when the client disconnects (generator closed).
            cancelled.set()
            worker.join()
        # Not reached when the client disconnects: closing the generator stops at the finally above.
        yield usage_event(int(inputs["input_ids"].shape[1]), None)
        yield done_event("end_turn")

    def _schedule_unload(self) -> None:
        if self._idle_timer:
            self._idle_timer.cancel()
        self._idle_timer = threading.Timer(self._idle_seconds, self.unload)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    def _unload_locked(self) -> None:
        if self._loaded is None:
            return
        self._loaded = None
        self._free_cuda()

    @staticmethod
    def _free_cuda() -> None:
        gc.collect()
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass
