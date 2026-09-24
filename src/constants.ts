export const SEEK_RESOLUTION = 1000;

export const ZOOM_STEP = 0.15;
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 2.5;

// Pages are typically full-resolution PNGs a couple MB each, and a long
// score can have dozens - loading them all upfront wastes bandwidth and
// memory for pages nobody's looking at (see PagesView's lazy-load).
export const PAGE_LOAD_MARGIN = '600px 0px';
