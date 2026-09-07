export interface VideoViewerProps {
  readonly src: string;
  readonly onError?: () => void;
}

/** A native `<video>` element with controls, filling the available space. */
export function VideoViewer({ src, onError }: VideoViewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-black">
      <video controls src={src} onError={onError} className="max-h-full max-w-full">
        <track kind="captions" />
      </video>
    </div>
  );
}
