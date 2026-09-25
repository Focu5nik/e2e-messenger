from typing import Annotated, TypeAlias

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from app.chats.direct_chat_service import DirectChatService
from app.chats.read_service import ChatReadService
from app.chats.repository import ChatRepository
from app.database import get_session
from app.messages.repository import MessageRepository


DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def chat_service() -> DirectChatService:
    return DirectChatService()


def chat_read_service(connection: HTTPConnection) -> ChatReadService:
    return ChatReadService(
        ChatRepository(), MessageRepository(), event_bus=connection.app.state.event_bus
    )


Service: TypeAlias = Annotated[DirectChatService, Depends(chat_service)]
ReadService: TypeAlias = Annotated[ChatReadService, Depends(chat_read_service)]
