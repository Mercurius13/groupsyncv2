// Ingest layer: the vocabulary the whole pipeline speaks (mutation ops), the raw
// wire shapes Google's endpoints send, and the parsers that turn one into the other.

export type AuthorId = string;

export interface InsertOp {
  type: "insert";
  authorId: AuthorId;
  timestamp: number;
  position: number;
  text: string;
}

export interface DeleteOp {
  type: "delete";
  authorId: AuthorId;
  timestamp: number;
  range: { start: number; end: number };
}

export type MutationOp = InsertOp | DeleteOp;

export type MutationLog = MutationOp[];

/** Pulls the Google Doc ID out of a docs.google.com URL, handling both editor
 *  URLs and internal URLs where a /u/N/ account-index segment precedes the ID. */
export function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1]! : null;
}

export interface InsertStringCommand {
  ty: "is";
  ibi: number;
  s: string;
}

export interface DeleteStringCommand {
  ty: "ds";
  si: number;
  ei: number;
}

export interface MultiCommand {
  ty: "mlti";
  mts: unknown[];
}

export type KnownCommand = InsertStringCommand | DeleteStringCommand | MultiCommand;

export interface RawBundle {
  commands: unknown[];
  sid: string;
  reqId: number;
}

export interface RawSaveRequestBody {
  id: string;
  sid: string;
  rev: number;
  bundles: RawBundle[];
}

/** Narrows a raw command to an insert-string ("is") command.
 *  ibi is the insert index in the live document; s is the inserted text. */
export function isInsertStringCommand(cmd: unknown): cmd is InsertStringCommand {
  return !!cmd && typeof cmd === "object" && (cmd as { ty?: unknown }).ty === "is";
}

/** Narrows a raw command to a delete-string ("ds") command.
 *  si/ei are the removed index range, BOTH INCLUSIVE — `si === ei` deletes exactly
 *  one character (a backspace), as the captured `ds si:1881 ei:1881` runs show.
 *  commandToOps converts this to a half-open range at the parse boundary. */
export function isDeleteStringCommand(cmd: unknown): cmd is DeleteStringCommand {
  return !!cmd && typeof cmd === "object" && (cmd as { ty?: unknown }).ty === "ds";
}

/** Narrows a raw command to an "mlti" wrapper bundling several sub-commands
 *  under one author/timestamp; contents must be unwrapped and re-checked. */
export function isMultiCommand(cmd: unknown): cmd is MultiCommand {
  return (
    !!cmd &&
    typeof cmd === "object" &&
    (cmd as { ty?: unknown }).ty === "mlti" &&
    Array.isArray((cmd as { mts?: unknown }).mts)
  );
}

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

export type PushChangesPayload = [number, number, PushChangesBody];
export type PushSelectionPayload = [number, number, PushSelectionBody];
export type PushNoopPayload = ["noop"];
export type PushFramePayload = PushChangesPayload | PushSelectionPayload | PushNoopPayload;

export type PushFrame = [number, PushFramePayload];

/** Narrows a push-channel payload to the keep-alive "noop" frame.
 *  Noops carry no content and are skipped by the parser. */
export function isNoopPayload(payload: unknown): payload is PushNoopPayload {
  return Array.isArray(payload) && payload[0] === "noop";
}

/** Narrows a push-channel payload to a changes broadcast by body shape (a `c`
 *  array of change entries), since the leading numeric flag isn't documented. */
export function isChangesPayload(payload: unknown): payload is PushChangesPayload {
  if (!Array.isArray(payload) || payload.length < 3) return false;
  const body = payload[2] as { c?: unknown };
  return !!body && Array.isArray(body.c);
}

export interface CaptureError extends Error {
  reason: "unparseable-bundles" | "no-parseable-chunks";
}

/** Constructs a typed CaptureError carrying a machine-readable reason code
 *  alongside the human-readable message. */
function captureError(reason: CaptureError["reason"], message: string): CaptureError {
  const err = new Error(message) as CaptureError;
  err.reason = reason;
  return err;
}

export interface OutboundCaptureContext {
  authorId: AuthorId;
  timestamp: number;
}

/** Appends every op without spreading them as call arguments — a single bulk command
 *  (a document-wide find-and-replace, say) can unwrap into more ops than the engine
 *  will accept in one push(...), which would throw rather than parse. */
function pushAll(target: MutationOp[], ops: MutationOp[]): void {
  for (const op of ops) target.push(op);
}

/** Converts one raw command (is/ds, or mlti unwrapped recursively) into zero
 *  or more ops sharing the given author and timestamp; unknown kinds are skipped.
 *  `ds` carries an INCLUSIVE end index (`si === ei` is a one-character backspace),
 *  so it is converted here to the half-open range every downstream stage assumes —
 *  C4/C3: getting this boundary wrong silently drops deletions from the replay. */
export function commandToOps(cmd: unknown, authorId: AuthorId, timestamp: number): MutationOp[] {
  if (isInsertStringCommand(cmd)) {
    return [{ type: "insert", authorId, timestamp, position: cmd.ibi, text: cmd.s }];
  }
  if (isDeleteStringCommand(cmd)) {
    return [{ type: "delete", authorId, timestamp, range: { start: cmd.si, end: cmd.ei + 1 } }];
  }
  if (isMultiCommand(cmd)) {
    return cmd.mts.flatMap((sub) => commandToOps(sub, authorId, timestamp));
  }
  return [];
}

/** Parses a raw form-encoded POST body to .../save into ops authored by the
 *  local session; throws when the bundles field isn't valid JSON. */
export function parseOutboundSaveBody(rawFormBody: string, context: OutboundCaptureContext): MutationOp[] {
  const params = new URLSearchParams(rawFormBody);
  const bundlesRaw = params.get("bundles");
  if (!bundlesRaw) return [];

  let bundles: RawBundle[];
  try {
    bundles = JSON.parse(bundlesRaw) as RawBundle[];
  } catch {
    throw captureError("unparseable-bundles", "save request's 'bundles' field was not valid JSON — capture format may have changed.");
  }

  return commandsToOps(bundles, context);
}

/** Parses an already-decoded save request body into ops, for callers that
 *  decoded the form body themselves. */
export function parseOutboundSaveRequest(body: RawSaveRequestBody, context: OutboundCaptureContext): MutationOp[] {
  return commandsToOps(body.bundles, context);
}

/** Flattens every command in every bundle into ops sharing the given
 *  author/timestamp context. */
function commandsToOps(bundles: RawBundle[], context: OutboundCaptureContext): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const bundle of bundles) {
    for (const cmd of bundle.commands) {
      pushAll(ops, commandToOps(cmd, context.authorId, context.timestamp));
    }
  }
  return ops;
}

/** Splits the push channel's raw response text into its JSON chunks, following
 *  the repeating length-prefixed `<decimal-byte-length>\n<json>` wire format. */
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

/** Parses one push-channel change entry into ops, using the author ID and
 *  timestamp the server stamped on the entry. */
function parseChangeEntry(entry: PushChangeEntry): MutationOp[] {
  const [command, timestamp, authorId] = entry as [unknown, number, AuthorId, ...unknown[]];
  return commandToOps(command, authorId, timestamp);
}

/** Parses one push-channel frame into ops, skipping keep-alive noops and
 *  selection-only broadcasts that carry no content change. */
function parseFrame(frame: PushFrame): MutationOp[] {
  const [, payload] = frame;
  if (isNoopPayload(payload)) return [];
  if (!isChangesPayload(payload)) return [];
  const [, , body] = payload;
  const ops: MutationOp[] = [];
  for (const entry of body.c) {
    pushAll(ops, parseChangeEntry(entry));
  }
  return ops;
}

/** Parses the push channel's full raw response into server-attributed ops;
 *  skips a malformed trailing chunk but throws when nothing parses at all. */
export function parsePushChannelResponse(raw: string): MutationOp[] {
  const chunkTexts = tokenizeChunks(raw);
  const ops: MutationOp[] = [];
  let parsedCount = 0;

  for (const chunkText of chunkTexts) {
    let frames: PushFrame[];
    try {
      frames = JSON.parse(chunkText) as PushFrame[];
    } catch {
      continue;
    }
    parsedCount++;
    for (const frame of frames) {
      pushAll(ops, parseFrame(frame));
    }
  }

  if (chunkTexts.length > 0 && parsedCount === 0) {
    throw captureError("no-parseable-chunks", "push channel response had no parseable chunks — capture format may have changed.");
  }

  return ops;
}
