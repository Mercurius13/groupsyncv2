/**
 * Raw wire shapes for Google Docs' internal realtime collaboration
 * endpoints — confirmed from real captured traffic (2026-06-19), per
 * EXTENSION.MD F1.4 ("implemented against a real captured response, not an
 * assumed format"). Two distinct protocols:
 *
 * OUTBOUND — POST .../document/d/<id>/save. Ops the local browser pushes up
 * for edits made by whoever is signed into this session. No author field —
 * it's implicit (the session sending the request), so the caller supplies
 * authorId/timestamp from context.
 *
 * INBOUND — the realtime push channel (Google's classic length-prefixed
 * chunked long-poll stream: repeating `<byte-length>\n<json>` frames).
 * Broadcasts every connected client's changes (including the local session's
 * own, echoed back) WITH an explicit author ID per change, since the server
 * relays to everyone, not just the author — this is what makes multi-author
 * attribution possible without the outbound stream's missing-author problem.
 */

export interface InsertStringCommand {
  ty: "is";
  /** insert-begin-index: character index in the live document */
  ibi: number;
  /** inserted text */
  s: string;
}

export interface DeleteStringCommand {
  ty: "ds";
  /** start index, inclusive */
  si: number;
  /** end index, exclusive */
  ei: number;
}

/** Bundles multiple commands under one change-entry timestamp/author/rev.
 *  Confirmed both as a wrapper for non-content ops (spellcheck "as") AND for
 *  multiple real content ops (e.g. three "ds" deletes from one backspace
 *  burst) — so its contents must be unwrapped and re-checked, never assumed
 *  skippable just because "mlti" itself isn't is/ds. */
export interface MultiCommand {
  ty: "mlti";
  mts: unknown[];
}

/** Other command types ("ty" values) exist (formatting, structural ops, etc.)
 *  but haven't been observed yet — anything not is/ds/mlti is skipped rather
 *  than guessed at. This is also why origin-authorship survives reformats
 *  (F2.5): formatting ops never touch the live character set. */
export type KnownCommand = InsertStringCommand | DeleteStringCommand | MultiCommand;

export interface RawBundle {
  commands: unknown[];
  sid: string;
  reqId: number;
}

/** The decoded form body of a POST to .../document/d/<id>/save. */
export interface RawSaveRequestBody {
  id: string;
  sid: string;
  rev: number;
  bundles: RawBundle[];
}

export function isInsertStringCommand(cmd: unknown): cmd is InsertStringCommand {
  return !!cmd && typeof cmd === "object" && (cmd as { ty?: unknown }).ty === "is";
}

export function isDeleteStringCommand(cmd: unknown): cmd is DeleteStringCommand {
  return !!cmd && typeof cmd === "object" && (cmd as { ty?: unknown }).ty === "ds";
}

export function isMultiCommand(cmd: unknown): cmd is MultiCommand {
  return (
    !!cmd &&
    typeof cmd === "object" &&
    (cmd as { ty?: unknown }).ty === "mlti" &&
    Array.isArray((cmd as { mts?: unknown }).mts)
  );
}

// ── Inbound push channel (realtime broadcast to every connected client) ──

/** [command, clientTimestamp (ms), authorId, rev, sessionId, ...unknown extras].
 *  command is NOT narrowed here — could be is/ds (content) or mc/as/mlti
 *  (cursor/spellcheck/bundled-non-content, all intentionally ignored). */
export type PushChangeEntry = [unknown, number, string, number, ...unknown[]];

export interface PushChangesBody {
  c: PushChangeEntry[];
  mv?: number;
  fv?: number;
  mfb?: unknown;
  t?: string;
}

export interface PushSelectionBody {
  selection: unknown[];
}

/** [flag, serverTimestamp, body] — flag's meaning isn't confirmed (seen 0 for
 *  content changes, 10 for cursor-only selection broadcasts); not relied on,
 *  we discriminate on body shape instead. */
export type PushChangesPayload = [number, number, PushChangesBody];
export type PushSelectionPayload = [number, number, PushSelectionBody];
export type PushNoopPayload = ["noop"];
export type PushFramePayload = PushChangesPayload | PushSelectionPayload | PushNoopPayload;

/** Top-level unit in a decoded chunk: [sequenceNumber, payload]. */
export type PushFrame = [number, PushFramePayload];

export function isNoopPayload(payload: unknown): payload is PushNoopPayload {
  return Array.isArray(payload) && payload[0] === "noop";
}

export function isChangesPayload(payload: unknown): payload is PushChangesPayload {
  if (!Array.isArray(payload) || payload.length < 3) return false;
  const body = payload[2] as { c?: unknown };
  return !!body && Array.isArray(body.c);
}
