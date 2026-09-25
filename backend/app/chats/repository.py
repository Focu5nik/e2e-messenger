import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.chats.models import Chat, ChatMember, ChatReadState, DirectChatPair


class ChatRepository:
    async def lock_chat(
        self, session: AsyncSession, requester_id: uuid.UUID, chat_id: uuid.UUID,
    ) -> Chat | None:
        # Authorize in the locking query and lock only the chat row.
        return await session.scalar(
            select(Chat)
            .where(
                Chat.id == chat_id,
                Chat.type == "DIRECT",
                Chat.direct_pair.has(
                    (DirectChatPair.user_low_id == requester_id)
                    | (DirectChatPair.user_high_id == requester_id)
                ),
            )
            .with_for_update(of=Chat)
            .execution_options(populate_existing=True)
        )

    async def get_other_user_id(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        chat_id: uuid.UUID,
    ) -> uuid.UUID | None:
        pair = await session.execute(
            select(DirectChatPair.user_low_id, DirectChatPair.user_high_id)
            .join(DirectChatPair.chat)
            .where(
                DirectChatPair.chat_id == chat_id,
                Chat.type == "DIRECT",
                (
                    (DirectChatPair.user_low_id == requester_id)
                    | (DirectChatPair.user_high_id == requester_id)
                ),
            )
        )
        row = pair.one_or_none()
        if row is None:
            return None
        low_id, high_id = row
        return high_id if low_id == requester_id else low_id

    async def get_read_state(
        self, session: AsyncSession, chat_id: uuid.UUID, user_id: uuid.UUID,
    ) -> ChatReadState | None:
        return await session.scalar(
            select(ChatReadState)
            .where(ChatReadState.chat_id == chat_id, ChatReadState.user_id == user_id)
            .execution_options(populate_existing=True)
        )

    async def states_page(
        self, session: AsyncSession, user_id: uuid.UUID,
        after_chat_id: uuid.UUID | None, limit: int,
    ) -> list[Chat]:
        query = (
            select(Chat)
            .where(Chat.members.any(ChatMember.user_id == user_id))
            .options(selectinload(Chat.members).selectinload(ChatMember.read_state))
            .order_by(Chat.id).limit(limit + 1)
        )
        if after_chat_id is not None:
            query = query.where(Chat.id > after_chat_id)
        return list((await session.scalars(query)).all())
