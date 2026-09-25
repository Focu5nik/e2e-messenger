from typing import Annotated, TypeAlias

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from app.database import get_session
from app.messages.service import MessageService


DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def message_service(connection: HTTPConnection) -> MessageService:
    return MessageService(event_bus=connection.app.state.event_bus)


Service: TypeAlias = Annotated[MessageService, Depends(message_service)]
