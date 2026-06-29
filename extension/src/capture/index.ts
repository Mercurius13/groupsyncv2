import type { AuthorId, MutationOp } from "../types/mutation";
import {
  isChangesPayload,
  isDeleteStringCommand,
  isInsertStringCommand,
  isMultiCommand,
  isNoopPayload,
  type PushChangeEntry,
  type PushFrame,
  type RawBundle,
  type RawSaveRequestBody,
} from "./wire-types";

/**
 * CAPTURE LAYER — confirmed against real captured traffic on 2026-06-19 (see
 * wire-types.ts for the exact shapes). Per EXTENSION.MD F1.5: capture
 * failures must surface a clear, specific error rather than silently
 * emitting partial data. Two different failure-tolerance policies apply
 * here, deliberately:
 *   - An unparseable "bundles" field, or a response with NO successfully
 *     parsed chunks at all, throws — that's a structural break (the
 *     endpoint's format likely changed) and partial/empty output would be
 *     misleading.
 *   - A single malformed chunk WITHIN an otherwise-good push-channel
 *     response is skipped, not thrown — the inbound stream is a continuous
 *     long-poll and the trailing chunk in any given read can legitimately be
 *     mid-write/truncated; that's normal streaming behavior, not a format
 *     change. This is a deliberate tradeoff, not an oversight.
 */

export interface CaptureError extends Error {
  reason: "unparseable-bundles" | "no-parseable-chunks";
}

function captureError(reason: CaptureError["reason"], message: string): CaptureError {
  const err = new Error(message) as CaptureError;
  err.reason = reason;
  return err;
}

export interface OutboundCaptureContext {
  authorId: AuthorId;
  timestamp: number;
}

/** Converts one command (is/ds, or mlti unwrapped into its sub-commands) into
 *  zero or more ops, all sharing the same authorId/timestamp. Shared between
 *  the outbound and inbound parsers (and history.ts's retroactive fetch) so
 *  the mlti-unwrapping logic lives once. */
export function commandToOps(cmd: unknown, authorId: AuthorId, timestamp: number): MutationOp[] {
  if (isInsertStringCommand(cmd)) {
    return [{ type: "insert", authorId, timestamp, position: cmd.ibi, text: cmd.s }];
  }
  if (isDeleteStringCommand(cmd)) {
    return [{ type: "delete", authorId, timestamp, range: { start: cmd.si, end: cmd.ei } }];
  }
  if (isMultiCommand(cmd)) {
    return cmd.mts.flatMap((sub) => commandToOps(sub, authorId, timestamp));
  }
  return []; // unknown command "ty" — intentionally skipped, not guessed at.
}

/** Parses one decoded POST body to .../document/d/<id>/save into ops authored
 *  by the local session. `rawFormBody` is the raw application/x-www-form-urlencoded
 *  string (what you'd get from a network interception, before any UI decoding). */
export function parseOutboundSaveBody(rawFormBody: string, context: OutboundCaptureContext): MutationOp[] {
  const params = new URLSearchParams(rawFormBody);
  const bundlesRaw = params.get("bundles");
  if (!bundlesRaw) return []; // no edits in this particular save round-trip — not an error.

  let bundles: RawBundle[];
  try {
    bundles = JSON.parse(bundlesRaw) as RawBundle[];
  } catch {
    throw captureError("unparseable-bundles", "save request's 'bundles' field was not valid JSON — capture format may have changed.");
  }

  return commandsToOps(bundles, context);
}

/** Same as parseOutboundSaveBody but takes an already-decoded body (e.g. from
 *  RawSaveRequestBody.bundles), for callers that parsed the form body themselves. */
export function parseOutboundSaveRequest(body: RawSaveRequestBody, context: OutboundCaptureContext): MutationOp[] {
  return commandsToOps(body.bundles, context);
}

function commandsToOps(bundles: RawBundle[], context: OutboundCaptureContext): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const bundle of bundles) {
    for (const cmd of bundle.commands) {
      ops.push(...commandToOps(cmd, context.authorId, context.timestamp));
    }
  }
  return ops;
}

/**
 * Splits the realtime push channel's raw response text into its JSON chunks.
 * Wire format is a repeating `<decimal-byte-length>\n<json-of-that-length>`,
 * glued with no separator between one chunk's end and the next chunk's
 * length prefix.
 */
export function tokenizeChunks(raw: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i] as string)) i++;
    let j = i;
    while (j < raw.length && /[0-9]/.test(raw[j] as string)) j++;
    if (j === i) break;
    const len = parseInt(raw.slice(i, j), 10);
    i = j;
    if (raw[i] === "\n") i++;
    chunks.push(raw.slice(i, i + len));
    i += len;
  }
  return chunks;
}

/** Parses one [command, clientTimestamp, authorId, rev, ...] change entry
 *  into zero or more ops (zero if the command isn't a content edit — cursor
 *  move, spellcheck styling, etc; more than one if it's an mlti bundle). */
function parseChangeEntry(entry: PushChangeEntry): MutationOp[] {
  const [command, timestamp, authorId] = entry as [unknown, number, AuthorId, ...unknown[]];
  return commandToOps(command, authorId, timestamp);
}

/** Parses one decoded frame [seq, payload] into zero or more ops. */
function parseFrame(frame: PushFrame): MutationOp[] {
  const [, payload] = frame;
  if (isNoopPayload(payload)) return [];
  if (!isChangesPayload(payload)) return []; // selection-only broadcast, no content change
  const [, , body] = payload;
  const ops: MutationOp[] = [];
  for (const entry of body.c) {
    ops.push(...parseChangeEntry(entry));
  }
  return ops;
}

/** Parses the realtime push channel's full raw response text into ops,
 *  correctly attributed to whichever author the server tagged each one with —
 *  this is what makes multi-author attribution possible (see module docstring). */
export function parsePushChannelResponse(raw: string): MutationOp[] {
  const chunkTexts = tokenizeChunks(raw);
  const ops: MutationOp[] = [];
  let parsedCount = 0;

  for (const chunkText of chunkTexts) {
    let frames: PushFrame[];
    try {
      frames = JSON.parse(chunkText) as PushFrame[];
    } catch {
      continue; // possibly a still-in-flight trailing chunk — see module docstring.
    }
    parsedCount++;
    for (const frame of frames) {
      ops.push(...parseFrame(frame));
    }
  }

  if (chunkTexts.length > 0 && parsedCount === 0) {
    throw captureError("no-parseable-chunks", "push channel response had no parseable chunks — capture format may have changed.");
  }

  return ops;
}
