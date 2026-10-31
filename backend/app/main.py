from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.router import router as auth_router
from app.chats.router import router as chats_router
from app.config import get_settings
from app.database import get_session
from app.messages.router import router as messages_router
from app.realtime.events import ConnectionRegistry, InMemoryEventBus
from app.realtime.redis_events import RedisEventBus
from app.realtime.router import router as realtime_router

settings = get_settings()


@asynccontextmanager
async def lifespan(application: FastAPI):
    config = get_settings()
    registry = application.state.connection_registry
    if config.redis_url is None:
        application.state.event_bus = InMemoryEventBus(registry)
        yield
        return
    redis = Redis.from_url(
        config.redis_url.get_secret_value(),
        socket_connect_timeout=5,
        socket_timeout=5,
        retry=Retry(NoBackoff(), 0),
    )
    bus = RedisEventBus(registry, redis, config.redis_channel)
    application.state.event_bus = bus
    try:
        await bus.start()
        yield
    finally:
        await bus.stop()


api = FastAPI(title="Secure Messenger API", version="0.1.0", lifespan=lifespan)
api.state.connection_registry = ConnectionRegistry()
api.state.event_bus = InMemoryEventBus(api.state.connection_registry)

api.include_router(auth_router)
api.include_router(chats_router)
api.include_router(messages_router)
api.include_router(realtime_router)

app = CORSMiddleware(
    app=api,
    allow_origins=[str(settings.frontend_origin).rstrip("/")],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

@api.get("/health")
async def health(session: Annotated[AsyncSession, Depends(get_session)]) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        ) from exc
    return {"status": "ok", "database": "ok"}
