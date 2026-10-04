/**
 * Bounded FIFO mailbox.
 *
 * An actor processes one message at a time, so the mailbox is a plain queue
 * with a hard size limit (backpressure) and a system lane that always jumps
 * ahead of user messages (stop / restart notifications).
 */

const OVERFLOW = {
  /** Refuse the new message; tell() returns false, ask() rejects. */
  REJECT: 'reject',
  /** Drop the oldest queued message to make room. */
  DROP_OLDEST: 'drop-oldest',
  /** Drop the incoming message and keep the queue. */
  DROP_NEWEST: 'drop-newest',
};

const VALID_OVERFLOW = new Set(Object.values(OVERFLOW));

class Mailbox {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.overflow = VALID_OVERFLOW.has(options.overflow) ? options.overflow : OVERFLOW.REJECT;
    /** @type {object[]} user messages */
    this.queue = [];
    /** @type {object[]} system messages, drained first */
    this.system = [];
    this.dropped = 0;
    this.rejected = 0;
  }

  get size() {
    return this.queue.length + this.system.length;
  }

  get isFull() {
    return this.size >= this.maxSize;
  }

  /**
   * @param {object} envelope
   * @param {{system?: boolean}} [opts]
   * @returns {boolean} whether the message was accepted
   */
  push(envelope, opts = {}) {
    if (opts.system) {
      this.system.push(envelope);
      return true;
    }
    if (!this.isFull) {
      this.queue.push(envelope);
      return true;
    }
    switch (this.overflow) {
      case OVERFLOW.DROP_OLDEST: {
        const evicted = this.queue.shift() || this.system.shift();
        this.dropped += 1;
        if (evicted && typeof evicted.onDropped === 'function') evicted.onDropped();
        this.queue.push(envelope);
        return true;
      }
      case OVERFLOW.DROP_NEWEST:
        this.dropped += 1;
        if (typeof envelope.onDropped === 'function') envelope.onDropped();
        return false;
      case OVERFLOW.REJECT:
      default:
        this.rejected += 1;
        return false;
    }
  }

  shift() {
    if (this.system.length > 0) return this.system.shift();
    return this.queue.shift() || null;
  }

  /** Put a message ahead of its peers (used by retry handling). */
  pushFront(envelope) {
    this.queue.unshift(envelope);
    return true;
  }

  /** Drop every queued user message (used when an actor stops). */
  drain() {
    const all = [...this.system, ...this.queue];
    this.system = [];
    this.queue = [];
    return all;
  }

  clear() {
    this.dropped += this.queue.length + this.system.length;
    this.system = [];
    this.queue = [];
  }
}



export { OVERFLOW, Mailbox };
export default Mailbox;