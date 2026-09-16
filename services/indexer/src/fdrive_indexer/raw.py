"""Camera raw (Sony ARW, Canon CR2/CR3, Nikon NEF, DNG, ...) thumbnail sources via LibRaw.

Cameras embed a JPEG preview in every raw file, rendered by the camera itself. That
preview is what Finder, Lightroom's grid and phone galleries show, it is at least as
large as our biggest thumbnail on current bodies, and reading it costs a few MB of
seeks rather than a 40 MB demosaic. So it is the thumbnail source. Only when a file
has no usable preview does LibRaw develop the sensor data at half size.
"""

from __future__ import annotations

import io
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from PIL import Image

# LibRaw's `sizes.flip`: 0 upright, 3 rotated 180°, 5 rotated 90° counter-clockwise,
# 6 rotated 90° clockwise. Pillow's `ROTATE_90` turns counter-clockwise.
_FLIP_TO_TRANSPOSE: dict[int, str] = {3: "ROTATE_180", 5: "ROTATE_90", 6: "ROTATE_270"}

EXIF_ORIENTATION = 0x0112


def apply_flip(image: Image.Image, flip: int) -> Image.Image:
    """`image` turned upright by LibRaw's `flip` code; unchanged for 0 or an unknown code."""
    from PIL import Image as PILImage

    method = _FLIP_TO_TRANSPOSE.get(flip)
    if method is None:
        return image
    return image.transpose(getattr(PILImage.Transpose, method))


def has_exif_orientation(image: Image.Image) -> bool:
    """Whether `image` carries its own EXIF orientation, in which case
    `ImageOps.exif_transpose` turns it upright and the raw's flip must not be applied twice."""
    try:
        orientation = image.getexif().get(EXIF_ORIENTATION)
    except Exception:  # noqa: BLE001 - a malformed EXIF block is the same as none
        return False
    return isinstance(orientation, int) and orientation > 1


def preview_covers(width: int, height: int, longest_side: int | None) -> bool:
    """Whether a `width` x `height` preview is at least as large as the thumbnail it
    would be scaled to. A tiny 160px index thumbnail does not cover a 1024px one."""
    return longest_side is None or max(width, height) >= longest_side


def _preview_image(raw: Any) -> Image.Image | None:
    """The embedded preview as an upright Pillow image, or None when the file has none."""
    import rawpy
    from PIL import Image as PILImage
    from PIL import ImageOps

    try:
        thumb = raw.extract_thumb()
    except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError):
        return None
    picture: PILImage.Image
    if thumb.format == rawpy.ThumbFormat.JPEG:
        picture = PILImage.open(io.BytesIO(bytes(thumb.data)))
        picture.load()
        if has_exif_orientation(picture):
            return ImageOps.exif_transpose(picture) or picture
    else:
        picture = PILImage.fromarray(thumb.data)
    return apply_flip(picture, int(raw.sizes.flip))


def _developed_image(raw: Any) -> Image.Image:
    """The sensor data demosaiced by LibRaw at half size with the camera's white balance.
    LibRaw applies the orientation itself here."""
    from PIL import Image as PILImage

    return PILImage.fromarray(raw.postprocess(use_camera_wb=True, half_size=True))


def open_raw(abs_path: str, longest_side: int | None = None) -> Image.Image:
    """An upright RGB image for the raw file at `abs_path`, large enough for a
    `longest_side` thumbnail when the file allows it: the embedded preview when it
    covers that size, else a half-size development, else whatever preview exists."""
    import rawpy

    with rawpy.imread(abs_path) as raw:
        preview = _preview_image(raw)
        if preview is not None and preview_covers(preview.width, preview.height, longest_side):
            picture = preview
        else:
            try:
                picture = _developed_image(raw)
            except Exception:
                if preview is None:
                    raise
                picture = preview
    if picture.mode not in ("RGB", "RGBA"):
        picture = picture.convert("RGB")
    return picture
