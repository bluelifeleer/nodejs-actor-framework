'use strict';

/** Base class for everything this framework throws. */
class ActorFrameworkError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, details);
  }
}

/** The user's actor definition is not usable. */
class DefinitionError extends ActorFrameworkError {}

/** The mailbox rejected the message because it is full. */
class MailboxFullError extends ActorFrameworkError {}

/** `ask()` did not receive a reply in time. */
class AskTimeoutError extends ActorFrameworkError {}

/** The target actor is stopped, dead, or was never started. */
class ActorStoppedError extends ActorFrameworkError {}

/** No actor is registered under that id/path. */
class ActorNotFoundError extends ActorFrameworkError {}

/** Persistence failed. */
class PersistenceError extends ActorFrameworkError {}

/**
 * Raised inside a supervisor when a child exceeded its restart intensity:
 * the supervisor escalates by failing itself, so its own parent decides.
 */
class EscalationError extends ActorFrameworkError {}

module.exports = {
  ActorFrameworkError,
  DefinitionError,
  MailboxFullError,
  AskTimeoutError,
  ActorStoppedError,
  ActorNotFoundError,
  PersistenceError,
  EscalationError,
};
