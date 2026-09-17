# Images

Source images for ZTIMS. Nothing here is served directly — pages load images
from `public/` or from Cloudinary.

## ztims-seal.jpg

The municipal tourism seal, at 1024×1024. Every icon in `public/` is cut from
this one file:

| File | Size | Used for |
|---|---|---|
| `favicon.ico` | 16/32/48/64 | the browser tab |
| `favicon-96.png` | 96 | mid-size tabs, and the title bar on every public page |
| `favicon-192.png` | 192 | high-DPI tabs and bookmarks |
| `apple-touch-icon.png` | 180 | the iOS home screen |

The seal is a circle on a square canvas, so the icons are **not** straight
resizes: the disc is located, fitted to a circle and masked, and only then
scaled. Rescaling this file directly would leave the backdrop around the disc.

The iOS icon is flattened onto a light backdrop rather than kept transparent,
because iOS composites home-screen icons onto black.
