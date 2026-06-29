import { describe, expect, it } from "vitest";
import { parsePushChannelResponse, tokenizeChunks } from "./index";

function chunk(json: string): string {
  return `${json.length}\n${json}`;
}

describe("tokenizeChunks", () => {
  it("splits length-prefixed chunks glued back to back", () => {
    const raw = chunk('"hello"') + chunk('"bye"');
    expect(tokenizeChunks(raw)).toEqual(['"hello"', '"bye"']);
  });

  it("returns nothing for empty input", () => {
    expect(tokenizeChunks("")).toEqual([]);
  });
});

describe("parsePushChannelResponse", () => {
  it("ignores noop heartbeat frames", () => {
    const raw = chunk(JSON.stringify([[157, ["noop"]]]));
    expect(parsePushChannelResponse(raw)).toEqual([]);
  });

  it("ignores cursor/selection-only frames", () => {
    const raw = chunk(
      JSON.stringify([
        [
          158,
          [10, 1781886817054, { selection: [{ ty: "mc", cl: { loc_type: 0, si: 1874 } }, 1781887511402, "id-A", 6619] }],
        ],
      ])
    );
    expect(parsePushChannelResponse(raw)).toEqual([]);
  });

  it("extracts a real insert-string change entry with its author and timestamp", () => {
    // Lifted directly from a real captured push-channel response, 2026-06-19.
    const raw = chunk(
      JSON.stringify([
        [
          160,
          [
            0,
            1781886817056,
            {
              c: [
                [
                  { ty: "is", ibi: 1872, s: " " },
                  1781887518419,
                  "03917199682802182266",
                  6620,
                  "3b258b529b3c7b1",
                  6,
                  null,
                  null,
                  false,
                ],
              ],
              mv: 33,
              fv: 33,
              mfb: [33, ""],
              t: "zCAY8fmAjzRmDg",
            },
          ],
        ],
      ])
    );
    expect(parsePushChannelResponse(raw)).toEqual([
      { type: "insert", authorId: "03917199682802182266", timestamp: 1781887518419, position: 1872, text: " " },
    ]);
  });

  it("ignores spellcheck styling ('as') entries even with a real authorId-shaped string", () => {
    const raw = chunk(
      JSON.stringify([
        [
          162,
          [
            0,
            1781886817058,
            {
              c: [
                [
                  { ty: "as", st: "spellcheck", si: 1670, ei: 1872, sm: {} },
                  1781887518759,
                  "ANONYMOUS_06287517911256457317",
                  6620,
                  null,
                  null,
                  null,
                  null,
                  false,
                ],
              ],
              mv: 33,
              fv: 33,
              mfb: [33, ""],
              t: "zCAY8fmAjzRmDg",
            },
          ],
        ],
      ])
    );
    expect(parsePushChannelResponse(raw)).toEqual([]);
  });

  it("unwraps a real 'mlti' entry into multiple delete ops, instead of dropping them", () => {
    // Lifted directly from a real captured push-channel response, 2026-06-19 —
    // a single backspace burst bundled as three "ds" sub-commands under one "mlti".
    const raw = chunk(
      JSON.stringify([
        [
          255,
          [
            0,
            1781886817105,
            {
              c: [
                [
                  {
                    ty: "mlti",
                    mts: [
                      { ty: "ds", si: 1881, ei: 1881 },
                      { ty: "ds", si: 1880, ei: 1880 },
                      { ty: "ds", si: 1879, ei: 1879 },
                    ],
                  },
                  1781889053948,
                  "03917199682802182266",
                  6627,
                  "3b258b529b3c7b1",
                  12,
                  null,
                  null,
                  false,
                ],
              ],
              mv: 33,
              fv: 33,
              mfb: [33, ""],
              t: "Ng3kIrg0-c_21g",
            },
          ],
        ],
      ])
    );
    expect(parsePushChannelResponse(raw)).toEqual([
      { type: "delete", authorId: "03917199682802182266", timestamp: 1781889053948, range: { start: 1881, end: 1881 } },
      { type: "delete", authorId: "03917199682802182266", timestamp: 1781889053948, range: { start: 1880, end: 1880 } },
      { type: "delete", authorId: "03917199682802182266", timestamp: 1781889053948, range: { start: 1879, end: 1879 } },
    ]);
  });

  it("handles multiple glued chunks containing multiple frames each", () => {
    const chunkA = JSON.stringify([[157, ["noop"]]]);
    const chunkB = JSON.stringify([
      [
        163,
        [
          0,
          1781886817059,
          {
            c: [
              [
                { ty: "is", ibi: 1873, s: "gh" },
                1781887519837,
                "03917199682802182266",
                6621,
                "3b258b529b3c7b1",
                7,
                null,
                null,
                false,
              ],
            ],
            mv: 33,
            fv: 33,
            mfb: [33, ""],
            t: "4S8iqAKLIKTg6w",
          },
        ],
      ],
      [164, [10, 1781886817060, { selection: [] }]],
    ]);
    const raw = chunk(chunkA) + chunk(chunkB);
    expect(parsePushChannelResponse(raw)).toEqual([
      { type: "insert", authorId: "03917199682802182266", timestamp: 1781887519837, position: 1873, text: "gh" },
    ]);
  });

  it("tolerates a single malformed trailing chunk (likely a still-in-flight stream read)", () => {
    const goodChunk = JSON.stringify([[1, ["noop"]]]);
    const raw = chunk(goodChunk) + "5\nnotjs"; // malformed final chunk
    expect(parsePushChannelResponse(raw)).toEqual([]);
  });

  it("throws a clear, specific error when NO chunk in a non-empty response parses (F1.5)", () => {
    const raw = chunk("xxxxxxx") + chunk("yyyyyyy"); // both deliberately invalid JSON
    expect(() => parsePushChannelResponse(raw)).toThrow(/capture format may have changed/);
  });
});
