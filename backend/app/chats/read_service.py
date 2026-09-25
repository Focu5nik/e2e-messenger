import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.principal import Principal
from app.chats.errors import ChatNotFoundError, InvalidReadPositionError
from app.chats.models import ChatReadState
from app.chats.notifications import publish_chat_read
from app.chats.repository import ChatRepository
from app.chats.types import ChatStatesPage, ReadState
from app.messages.repository import MessageRepository
from app.realtime.events import EventBus


class ChatReadService:
    def __init__(
        self, chat_repository: ChatRepository, message_repository: MessageRepository,
        event_bus: EventBus | None = None,
    ) -> None:
        self.chat_repository = chat_repository
        self.message_repository = message_repository
        self.event_bus = event_bus

    async def advance(
        self, session: AsyncSession, principal: Principal,
        chat_id: uuid.UUID, last_read_seq: int,
    ) -> ReadState:
        other_user_id = await self.chat_repository.get_other_user_id(
            session, principal.user_id, chat_id
        )
        if other_user_id is None:
            raise ChatNotFoundError
        chat = await self.chat_repository.lock_chat(session, principal.user_id, chat_id)
        if chat is None:
            raise ChatNotFoundError
        if last_read_seq < 0 or last_read_seq > chat.last_message_seq:
            raise InvalidReadPositionError
        if last_read_seq and not await self.message_repository.chat_position_exists(
            session, chat_id, last_read_seq
        ):
            raise InvalidReadPositionError

        # The chat lock also serializes first-row insertion and concurrent advances.
        state = await self.chat_repository.get_read_state(session, chat_id, principal.user_id)
        changed = last_read_seq > (state.last_read_seq if state else 0)
        if changed:
            if state is None:
                state = ChatReadState(chat_id=chat_id, user_id=principal.user_id)
                session.add(state)
            state.last_read_seq = last_read_seq
            state.updated_at = datetime.now(UTC)
        saved = ReadState(
            chat_id=chat_id, user_id=principal.user_id,
            last_read_seq=state.last_read_seq if state else 0,
            updated_at=state.updated_at if state else None,
        )
        devices = []
        if changed:
            for user_id in (principal.user_id, other_user_id):
                devices += await self.message_repository.get_active_devices(session, user_id)
        await session.commit()
        if changed:
            await publish_chat_read(self.event_bus, [device.id for device in devices], saved)
        return saved

    async def page(
        self, session: AsyncSession, principal: Principal,
        after_chat_id: uuid.UUID | None, limit: int,
    ) -> ChatStatesPage:
        chats = await self.chat_repository.states_page(
            session, principal.user_id, after_chat_id, limit
        )
        selected = chats[:limit]
        return ChatStatesPage(
            chats=selected,
            next_chat_id=selected[-1].id if selected else after_chat_id,
            has_more=len(chats) > limit,
        )
