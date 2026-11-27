package main

import (
	"bytes"
	"errors"
	"image"
	"syscall"
	"time"
	"unsafe"

	"msfwr.local/host/jpeg444"
)

var (
	user          = syscall.NewLazyDLL("user32.dll")
	gdi           = syscall.NewLazyDLL("gdi32.dll")
	getDC         = user.NewProc("GetDC")
	releaseDC     = user.NewProc("ReleaseDC")
	getMetrics    = user.NewProc("GetSystemMetrics")
	getAsyncKey   = user.NewProc("GetAsyncKeyState")
	openDesktop   = user.NewProc("OpenInputDesktop")
	closeDesktop  = user.NewProc("CloseDesktop")
	getObjectInfo = user.NewProc("GetUserObjectInformationW")
	createDC      = gdi.NewProc("CreateCompatibleDC")
	deleteDC      = gdi.NewProc("DeleteDC")
	createDIB     = gdi.NewProc("CreateDIBSection")
	selectObject  = gdi.NewProc("SelectObject")
	deleteObject  = gdi.NewProc("DeleteObject")
	stretch       = gdi.NewProc("StretchBlt")
	stretchMode   = gdi.NewProc("SetStretchBltMode")
)

func setDPI() {
	dpi := user.NewProc("SetProcessDpiAwarenessContext")
	if dpi.Find() != nil {
		user.NewProc("SetProcessDPIAware").Call()
		return
	}
	if ok, _, _ := dpi.Call(^uintptr(3)); ok == 0 {
		user.NewProc("SetProcessDPIAware").Call()
	}
}

func stopPressed() bool {
	keyDown := func(key uintptr) bool {
		v, _, _ := getAsyncKey.Call(key)
		return v&0x8000 != 0
	}
	return (keyDown(0x11) && keyDown(0x32)) || keyDown(0x7b)
}

func inputDesktopName() string {
	d, _, _ := openDesktop.Call(0, 0, 1)
	if d == 0 {
		return ""
	}
	defer closeDesktop.Call(d)
	var buf [128]uint16
	var size uint32
	ok, _, _ := getObjectInfo.Call(d, 2, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:])
}

// onDefaultDesktop reports whether the desktop receiving keyboard and mouse
// input right now is the normal user desktop. Exam lockdown browsers (e.g.
// Pearson VUE / Respondus) switch input to a separate secure desktop, which
// stops screen sharing; see secureDesktopGrace for how long we tolerate that.
func onDefaultDesktop() bool {
	return inputDesktopName() == "Default"
}

// secureDesktopGrace is how long the shared screen may keep streaming while
// input sits on a protected/secure desktop. Some lockdown apps flip input to
// their secure desktop only briefly at launch (or during prompts); ending the
// session instantly made those look like crashes. After this window the
// session still ends, because capturing and injecting into a secure desktop
// from a normal process is not possible in Windows.
const secureDesktopGrace = 30 * time.Second

var nonDefaultSince time.Time

// desktopAllowed reports whether it is fine to keep streaming right now. The
// first time input leaves the Default desktop it starts a grace window: the
// screen keeps updating (the Default desktop stays composed behind the
// overlay) so brief switches do not drop the connection. If input stays away
// past the window, streaming stops.
func desktopAllowed() bool {
	if onDefaultDesktop() {
		nonDefaultSince = time.Time{}
		return true
	}
	if nonDefaultSince.IsZero() {
		nonDefaultSince = time.Now()
	}
	return time.Since(nonDefaultSince) < secureDesktopGrace
}

func metric(which uintptr) int {
	n, _, _ := getMetrics.Call(which)
	return int(int32(n))
}

func sameScreen(w, h int) bool { return metric(0) == w && metric(1) == h }

type dibInfo struct {
	Size                                            uint32
	Width, Height                                   int32
	Planes, Bits                                    uint16
	Compression, ImageSize, X, Y, Colors, Important uint32
}

// capturer grabs the primary screen at its native resolution (scaled down
// only past the limit the viewer's picture quality sets) into a DIB it keeps
// between frames. It keeps the last frame it reported, so it can tell
// which regions changed and convert only those.
type capturer struct {
	src, dst, bitmap, old uintptr
	pixel                 *byte
	w, h, dw, dh          int
	maxW, maxH            int         // the largest picture sent; 0 means the default
	prev                  []byte      // BGRA of the last frame reported
	img                   *image.RGBA // RGBA of the last frame reported
}

func newCapturer() *capturer { return &capturer{} }

// limit sets the largest picture sent. A change takes effect on the next
// grab, which then reports the whole screen.
func (c *capturer) limit(maxW, maxH int) {
	if c.maxW != maxW || c.maxH != maxH {
		c.maxW, c.maxH = maxW, maxH
		c.w, c.h = 0, 0 // force setup
	}
}

func (c *capturer) close() {
	if c.dst != 0 {
		if c.old != 0 {
			selectObject.Call(c.dst, c.old)
		}
		deleteDC.Call(c.dst)
	}
	if c.bitmap != 0 {
		deleteObject.Call(c.bitmap)
	}
	if c.src != 0 {
		releaseDC.Call(0, c.src)
	}
	*c = capturer{maxW: c.maxW, maxH: c.maxH}
}

func (c *capturer) setup(w, h int) error {
	fail := errors.New("could not capture the primary screen")
	c.close()
	c.w, c.h = w, h
	maxW, maxH := c.maxW, c.maxH
	if maxW <= 0 || maxH <= 0 {
		def := profileFor(defaultProfile)
		maxW, maxH = def.maxW, def.maxH
	}
	c.dw, c.dh = fitted(w, h, maxW, maxH)
	c.src, _, _ = getDC.Call(0)
	if c.src == 0 {
		return fail
	}
	c.dst, _, _ = createDC.Call(c.src)
	if c.dst == 0 {
		c.close()
		return fail
	}
	info := dibInfo{Size: 40, Width: int32(c.dw), Height: -int32(c.dh), Planes: 1, Bits: 32}
	c.bitmap, _, _ = createDIB.Call(c.dst, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&c.pixel)), 0, 0)
	if c.bitmap == 0 || c.pixel == nil {
		c.close()
		return fail
	}
	c.old, _, _ = selectObject.Call(c.dst, c.bitmap)
	if c.old == 0 || c.old == ^uintptr(0) {
		c.old = 0
		c.close()
		return fail
	}
	// HALFTONE averages pixels when the screen is scaled down, which keeps
	// text legible; at native size it is a plain copy.
	stretchMode.Call(c.dst, 4)
	gdi.NewProc("SetBrushOrgEx").Call(c.dst, 0, 0, 0)
	return nil
}

// grab captures the screen. It returns the frame (shared with the
// capturer, valid until the next grab), the real screen size, and the
// regions that changed since the last grab: nil when nothing changed, and
// the whole frame on the first grab or after the screen size changed.
func (c *capturer) grab() (*image.RGBA, int, int, []image.Rectangle, error) {
	fail := errors.New("could not capture the primary screen")
	w, h := metric(0), metric(1)
	if w <= 0 || h <= 0 || w > 32768 || h > 32768 {
		return nil, 0, 0, nil, fail
	}
	fresh := false
	if c.bitmap == 0 || w != c.w || h != c.h {
		if err := c.setup(w, h); err != nil {
			return nil, 0, 0, nil, err
		}
		fresh = true
	}
	ret, _, _ := stretch.Call(c.dst, 0, 0, uintptr(c.dw), uintptr(c.dh), c.src, 0, 0, uintptr(w), uintptr(h), 0x40cc0020)
	if ret == 0 {
		return nil, 0, 0, nil, fail
	}
	gdi.NewProc("GdiFlush").Call()
	bgra := unsafe.Slice(c.pixel, c.dw*c.dh*4)
	full := image.Rect(0, 0, c.dw, c.dh)
	var rects []image.Rectangle
	if fresh || c.img == nil {
		c.prev = make([]byte, len(bgra))
		c.img = image.NewRGBA(full)
		rects = []image.Rectangle{full}
	} else {
		rects = dirtyRects(c.prev, bgra, c.dw, c.dh)
	}
	stride := c.dw * 4
	for _, r := range rects {
		for y := r.Min.Y; y < r.Max.Y; y++ {
			from, to := y*stride+r.Min.X*4, y*stride+r.Max.X*4
			copy(c.prev[from:to], bgra[from:to])
			src, dst := bgra[from:to], c.img.Pix[from:to]
			for i := 0; i < len(src); i += 4 {
				dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], 255
			}
		}
	}
	return c.img, w, h, rects, nil
}

// encodeJPEG encodes img (or a region of it) at quality, lowering quality
// until it fits in limit bytes. Colour keeps full resolution (4:4:4) unless
// subsample is set, so coloured and anti-aliased text stays sharp.
func encodeJPEG(img image.Image, quality int, subsample bool, limit int) ([]byte, error) {
	for _, q := range []int{quality, 60, 40, 25} {
		if q > quality {
			continue
		}
		var buf bytes.Buffer
		if err := jpeg444.Encode(&buf, img, &jpeg444.Options{Quality: q, Subsample: subsample}); err != nil {
			return nil, err
		}
		if buf.Len() <= limit {
			return buf.Bytes(), nil
		}
		subsample = true
	}
	return nil, errors.New("screen frame is too large for the relay")
}
