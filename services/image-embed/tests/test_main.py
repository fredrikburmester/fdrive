from __future__ import annotations

import time

import pytest
from conftest import FakeEmbedder

from fdrive_image_embed import main
from fdrive_image_embed.server import ModelHolder


def _wait_until(predicate: object, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(interval)
    return predicate()  # type: ignore[operator]


def test_log_prints_a_timestamped_line(capsys: pytest.CaptureFixture[str]) -> None:
    main.log("hello")
    out = capsys.readouterr().out
    assert "hello" in out


# -- load_in_background -------------------------------------------------------------


def test_load_in_background_sets_the_holder_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    holder = ModelHolder()
    logs: list[str] = []

    def fake_load(model_id: str, device: str, threads: int | None, batch_size: int) -> FakeEmbedder:
        return FakeEmbedder(model_id=model_id, dim=4)

    monkeypatch.setattr(main, "load_embedder", fake_load)
    main.load_in_background(holder, "some/model", "cpu", None, 8, logs.append)

    loaded = holder.get()
    assert loaded is not None
    assert loaded.model_id == "some/model"
    assert any("model loaded" in line for line in logs)


def test_load_in_background_logs_and_leaves_the_holder_empty_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    holder = ModelHolder()
    logs: list[str] = []

    def boom(model_id: str, device: str, threads: int | None, batch_size: int) -> FakeEmbedder:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(main, "load_embedder", boom)
    main.load_in_background(holder, "some/model", "cpu", None, 8, logs.append)

    assert holder.get() is None
    assert any("model load failed" in line for line in logs)


# -- main -----------------------------------------------------------------------


def test_main_wires_everything_and_serves(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_EMBED_MODEL", "some/model")
    monkeypatch.setenv("IMAGE_EMBED_PORT", "0")
    monkeypatch.setenv("IMAGE_EMBED_DEVICE", "cpu")

    monkeypatch.setattr(main, "load_embedder", lambda model_id, device, threads, batch_size: FakeEmbedder(model_id, 4))

    served: dict[str, object] = {}

    def fake_uvicorn_run(app: object, **kwargs: object) -> None:
        served["app"] = app
        served["kwargs"] = kwargs

    monkeypatch.setattr(main.uvicorn, "run", fake_uvicorn_run)

    main.main()

    assert served["kwargs"]["port"] == 0  # type: ignore[index]
    state = served["app"].state.server_state  # type: ignore[attr-defined]
    assert state.model_id == "some/model"
    assert state.device == "cpu"
    assert _wait_until(lambda: state.holder.get() is not None)
    assert state.holder.get().model_id == "some/model"  # type: ignore[union-attr]


def test_main_resolves_auto_device_via_cuda_available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGE_EMBED_MODEL", "some/model")
    monkeypatch.setenv("IMAGE_EMBED_PORT", "0")
    monkeypatch.delenv("IMAGE_EMBED_DEVICE", raising=False)

    monkeypatch.setattr(main, "cuda_available", lambda: True)
    monkeypatch.setattr(main, "load_embedder", lambda model_id, device, threads, batch_size: FakeEmbedder(model_id, 4))

    served: dict[str, object] = {}

    def fake_uvicorn_run(app: object, **kwargs: object) -> None:
        served["app"] = app

    monkeypatch.setattr(main.uvicorn, "run", fake_uvicorn_run)

    main.main()

    state = served["app"].state.server_state  # type: ignore[attr-defined]
    assert state.device == "cuda"
