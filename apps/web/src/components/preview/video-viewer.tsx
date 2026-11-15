export interface VideoViewerProps {
  readonly src: string;
  /** WebVTT tracks the viewer's captions menu offers; none is on by default. */
  readonly subtitles?: readonly { readonly src: string; readonly label: string }[];
  readonly onError?: () => void;
}

/** A native `<video>` element with controls, filling the available space. */
export function VideoViewer({ src, subtitles = [], onError }: VideoViewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-black">
      <video controls src={src} onError={onError} className="max-h-full max-w-full">
        <track kind="captions" />
        {subtitles.map((track) => (
          <track key={track.src} kind="subtitles" src={track.src} label={track.label} />
        ))}
      </video>
    </div>
  );
}
