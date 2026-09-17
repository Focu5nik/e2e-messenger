from pathlib import Path

from app.config import Settings


def test_default_env_file_belongs_to_backend() -> None:
    assert Settings.model_config["env_file"] == (
        Path(__file__).resolve().parents[1] / ".env"
    )


def test_env_loading_is_independent_of_working_directory(tmp_path, monkeypatch) -> None:
    backend_env = tmp_path / "backend" / ".env"
    backend_env.parent.mkdir()
    backend_env.write_text(
        "DATABASE_URL=sqlite+aiosqlite:///backend.db\n"
        "FRONTEND_ORIGIN=http://localhost:5180\n",
        encoding="utf-8",
    )
    (tmp_path / ".env").write_text(
        "DATABASE_URL=sqlite+aiosqlite:///wrong.db\n", encoding="utf-8"
    )
    monkeypatch.setitem(Settings.model_config, "env_file", backend_env)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("FRONTEND_ORIGIN", raising=False)

    for directory in (tmp_path, backend_env.parent):
        monkeypatch.chdir(directory)
        settings = Settings()
        assert settings.database_url == "sqlite+aiosqlite:///backend.db"
        assert str(settings.frontend_origin) == "http://localhost:5180/"

    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///override.db")
    assert Settings().database_url == "sqlite+aiosqlite:///override.db"
