class EnvelopeNotFoundError(Exception):
    pass


class DuplicateDestinationError(Exception):
    pass


class InvalidEnvelopeError(Exception):
    pass


class DeliveryTargetsChangedError(Exception):
    pass


class MailboxInvariantError(RuntimeError):
    pass
