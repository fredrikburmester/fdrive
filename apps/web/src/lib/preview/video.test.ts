import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { playsNatively, subtitlesFor } from "./video";

function file(name: string, kind: FsEntry["kind"] = "file") {
  const dot = name.lastIndexOf(".");
  return { name, path: `/films/${name}`, ext: name.slice(dot).toLowerCase(), kind };
}

describe("playsNatively", () => {
  it("plays mp4, m4v, mov and webm in the browser and transcodes every other video", () => {
    expect([".mp4", ".M4V", ".mov", ".webm"].map(playsNatively)).toEqual([true, true, true, true]);
    expect([".mkv", ".avi", ".wmv", ".flv", ".mpg"].map(playsNatively)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("subtitlesFor", () => {
  it("offers the srt and vtt files named after the video, labelled by what the name adds", () => {
    const entries = [
      file("Movie.mkv"),
      file("Movie.srt"),
      file("Movie.en.srt"),
      file("Movie.sv.VTT"),
      file("Movie.txt"),
      file("Movies.srt"),
      file("Other.en.srt"),
      file("Movie.dir.srt", "dir"),
    ];

    expect(subtitlesFor(file("Movie.mkv"), entries)).toEqual([
      { path: "/films/Movie.srt", label: "Subtitles" },
      { path: "/films/Movie.en.srt", label: "en" },
      { path: "/films/Movie.sv.VTT", label: "sv" },
    ]);
  });
});
