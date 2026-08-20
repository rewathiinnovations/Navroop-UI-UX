/**
 * The `complete` frame's reply payload, decided in one place.
 *
 * Every chunk of a generation is already sent to the browser as a `stream`
 * frame, and the `complete` frame then carried `generatedCode` — the whole
 * accumulated reply — a second time. That is the largest payload in the product,
 * doubled on the wire on every build, and it landed in two more copies of client
 * state (F-043).
 *
 * It is not redundant in principle: a reply the client cannot have accumulated
 * has to arrive somehow. So the route asks `shouldSendGeneratedCode` and the
 * client asks `completedCodeFromFrame`, and the two halves of the contract sit
 * next to each other rather than drifting apart in a route and a store.
 */

export type StreamedReplyState = {
  /**
   * How many provider attempts streamed `raw` frames to this client. A failover
   * retry streams a second reply into the same client buffer and nothing tells
   * the client to drop the first, so anything above one makes the buffer
   * unusable as the reply.
   */
  streamAttempts: number;
  /**
   * Whether the reply was rewritten after it was streamed — the corrective ask
   * replacing it wholesale, or truncation recovery swapping a block back in. The
   * client's buffer then holds text the server no longer considers the reply.
   */
  replyRewritten: boolean;
  /** Bytes the client received on `stream` frames. Zero means it has nothing. */
  streamedChars: number;
};

/**
 * Whether the `complete` frame must carry the reply.
 *
 * True whenever the client cannot already hold it byte-for-byte. Defaulting to
 * sending is deliberate: an extra copy costs bandwidth, a missing one costs the
 * build.
 */
export function shouldSendGeneratedCode(state: StreamedReplyState): boolean {
  if (state.streamedChars <= 0) return true;
  if (state.streamAttempts !== 1) return true;
  return state.replyRewritten;
}

/**
 * The reply, from the frame when it carried one and from the client's own
 * accumulated `stream` text otherwise.
 */
export function completedCodeFromFrame(frameCode: unknown, accumulated: string): string {
  if (typeof frameCode === 'string' && frameCode.length > 0) return frameCode;
  return accumulated;
}
