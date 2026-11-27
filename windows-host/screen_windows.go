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
	user            = syscall.NewLazyDLL("user32.dll")
	gdi             = syscall.NewLazyDLL("gdi32.dll")
	d3d9            = syscall.NewLazyDLL("d3d9.dll")
	getDC           = user.NewProc("GetDC")
	releaseDC       = user.NewProc("ReleaseDC")
	getMetrics      = user.NewProc("GetSystemMetrics")
	getAsyncKey     = user.NewProc("GetAsyncKeyState")
	openDesktop     = user.NewProc("OpenInputDesktop")
	closeDesktop    = user.NewProc("CloseDesktop")
	getObjectInfo   = user.NewProc("GetUserObjectInformationW")
	createDC        = gdi.NewProc("CreateCompatibleDC")
	deleteDC        = gdi.NewProc("DeleteDC")
	createDIB       = gdi.NewProc("CreateDIBSection")
	selectObject    = gdi.NewProc("SelectObject")
	deleteObject    = gdi.NewProc("DeleteObject")
	stretch         = gdi.NewProc("StretchBlt")
	stretchMode     = gdi.NewProc("SetStretchBltMode")
	direct3DCreate9 = d3d9.NewProc("Direct3DCreate9")
)

// D3DCREATE constants and the vtable indices of the Direct3D9 methods we use.
const (
	d3DCreateHardware    = 0x00000010 // D3DCREATE_HARDWARE_VERTEXPROCESSING
	iCreateDevice        = 16         // IDirect3D9::CreateDevice
	iGetAdapterDisplayMo = 34         // IDirect3D9::GetAdapterDisplayMode
	devTestCoop          = 17         // IDirect3DDevice9::TestCooperativeLevel
	devGetBackBuffer     = 25         // IDirect3DDevice9::GetBackBuffer
	devCreateImageSurf   = 86         // IDirect3DDevice9::CreateOffscreenPlainSurface (Ex is 87)
	devRectToRect        = 153        // IDirect3DDevice9::StretchRect (Ex is 154)
	surfLock             = 3          // IDirect3DSurface9::LockRect
	surfUnlock           = 4          // IDirect3DSurface9::UnlockRect
	surfRelease          = 2          // IDirect3DSurface9::Release
)

// d3d9PresentFlags mirrors D3DPRESENT_PARAMETERS (the trailing fields are
// zeroed by Go's allocator before we fill what matters).
type d3d9PresentFlags struct {
	BackBufferWidth                uint32
	BackBufferHeight               uint32
	BackBufferFormat               uint32
	BackBufferCount                uint32
	MultiSampleType                uint32
	MultiSampleQuality             uint32
	SwapEffect                     uint32
	hDeviceWindow                  uintptr
	Windowed                       uint32
	EnableAutoDepthStencil         uint32
	AutoDepthStencilFormat         uint32
	Flags                          uint32
	FullScreen_RefreshRateInHz     uint32
	PresentationInterval   uint32
	DepthSwapEffect        uint32
	Usage                  uint32
	Win8                   uint32
	_                      [3]uint32
}

// d3d9Mode mirrors D3DDISPLAYMODE.
type d3d9Mode struct {
	Width, Height, RefreshRate, Format uint32
}

// d3d9LockedRect mirrors D3DLOCKED_RECT.
type d3d9LockedRect struct {
	Pitch int32
	pBits *byte
}

// slot returns the address of a COM vtable entry. obj is a pointer returned by
// a system DLL (opaque to the garbage collector), so reading its vtable is the
// standard way to dispatch Direct3D calls from raw pointers.
func slot(obj uintptr, index int) uintptr {
	v := *(*uintptr)(unsafe.Pointer(obj))
	return v + uintptr(index)*ptrSize
}
// The D3D9 back buffer holds the last presented frame of the default desktop,
// which GDI screen DCs do not always expose once a fullscreen or lockdown
// application takes over, so it serves as a second capture path. It is rebuilt
// lazily whenever the GDI path goes quiet.
type dxCapturer struct {
	vdev, vsurf uintptr // device / surface COM vtables
	dev, surf   uintptr // COM object pointers
	w, h        int
	prev        []byte // last copied frame, to detect stale echoes
}

func (d *dxCapturer) ok() bool { return d.dev != 0 && d.surf != 0 }

func (d *dxCapturer) dispose() {
	if d.surf != 0 {
		call3(slot(d.surf, surfRelease), d.surf, 0, 0)
		d.surf = 0
	}
	if d.dev != 0 {
		v := *(*uintptr)(unsafe.Pointer(d.dev))
		// Release is slot 2 for every COM interface; IDirect3DDevice9 has no
		// extra leading slots.
		call3(v+surfRelease*ptrSize, d.dev, 0, 0)
		d.dev = 0
	}
	d.vdev, d.vsurf = 0, 0
	d.w, d.h = 0, 0
}

var ptrSize = unsafe.Sizeof(uintptr(0))

func call3(a, b, c, e uintptr) uintptr {
	r, _, _ := syscall.SyscallN(a, b, c, e)
	return r
}

func call6(a, b, c, e, f, g, hh uintptr) uintptr {
	r, _, _ := syscall.SyscallN(a, b, c, e, f, g, hh)
	return r
}

// call7 covers the six-argument COM methods (e.g. CreateDevice and
// CreateOffscreenPlainSurface, whose trailing unused slot keeps stack
// alignment on x64).
func call7(a, b, c, e, f, g, hh, i uintptr) uintptr {
	r, _, _ := syscall.SyscallN(a, b, c, e, f, g, hh, i)
	return r
}

// build creates the device and a scratch surface sized to the current mode.
func (d *dxCapturer) build(w, h int) error {
	d.dispose()
	fail := errors.New("direct3d capture unavailable")
	if direct3DCreate9.Find() != nil {
		return fail
	}
	obj, _, _ := direct3DCreate9.Call(32) // D3D_SDK_VERSION
	if obj == 0 {
		return fail
	}
	defer call3(slot(obj, surfRelease), obj, 0, 0) // IDirect3D9::Release is slot 2
	var mode d3d9Mode
	if hr := call3(slot(obj, iGetAdapterDisplayMo), obj, 0, uintptr(unsafe.Pointer(&mode))); hr != 0 {
		return fail
	}
	if mode.Width == 0 || mode.Height == 0 {
		return fail
	}
	pp := d3d9PresentFlags{
		BackBufferWidth:  mode.Width,
		BackBufferHeight: mode.Height,
		BackBufferFormat: 0, // D3DFMT_UNKNOWN: match desktop
		BackBufferCount:  1,
		SwapEffect:       1, // D3DSWAPEFFECT_COPY
		Windowed:         1,
	}
	var dev uintptr
	// D3DDEVTYPE_NULLREF (4) works headless and without real hardware; the
	// NULL reference device still exposes the composited back buffer on most
	// drivers. Fall back to HAL (1) if creation fails.
	for _, devType := range []uintptr{4, 1} {
		hr := call6(slot(obj, iCreateDevice), obj, devType, 0, d3DCreateHardware,
			uintptr(unsafe.Pointer(&pp)), uintptr(unsafe.Pointer(&dev)))
		if hr == 0 && dev != 0 {
			break
		}
		dev = 0
	}
	if dev == 0 {
		return fail
	}
	v := *(*uintptr)(unsafe.Pointer(dev))
	if hr := call3(v+devTestCoop*ptrSize, dev, 0, 0); hr != 0 {
		call3(v+surfRelease*ptrSize, dev, 0, 0)
		return fail
	}
	var surf uintptr
	// D3DFMT_A8R8G8B8 == 21, D3DPOOL_DEFAULT == 0. Try plain usage first; on
	// the reference device retry with D3DUSAGE_DYNAMIC|SOFTWAREPROCESSING so
	// LockRect can read the pixels back.
	hr := call7(slot(dev, devCreateImageSurf), dev, uintptr(mode.Width), uintptr(mode.Height), 21, 0, uintptr(unsafe.Pointer(&surf)), 0)
	if hr != 0 || surf == 0 {
		hr = call7(slot(dev, devCreateImageSurf), dev, uintptr(mode.Width), uintptr(mode.Height), 21, uintptr(0x20|0x04), uintptr(unsafe.Pointer(&surf)), 0)
	}
	if hr != 0 || surf == 0 {
		call3(v+surfRelease*ptrSize, dev, 0, 0)
		return fail
	}
	d.vdev, d.dev = v, dev
	d.vsurf, d.surf = *(*uintptr)(unsafe.Pointer(surf)), surf
	d.w, d.h = int(mode.Width), int(mode.Height)
	return nil
}

// grab copies the composited back buffer into dst (BGRA, top-down, stride
// dw*4). It returns true when the copied frame differs from last, which lets
// the caller fall back to GDI while the reference device echoes stale frames.
func (d *dxCapturer) grab(dst []byte, dw, dh int) (bool, error) {
	fail := errors.New("direct3d capture failed")
	if !d.ok() || d.w != dw || d.h != dh {
		if err := d.build(dw, dh); err != nil {
			return false, err
		}
		d.prev = make([]byte, 0)
	}
	var buf uintptr
	// GetBackBuffer(SWAPCHAIN_PRIMARY=0, 0, D3DBACKBUFFER_TYPE_MONO=0, &bb)
	if hr := call6(slot(d.dev, devGetBackBuffer), d.dev, 0, 0, 0, uintptr(unsafe.Pointer(&buf)), 0); hr != 0 || buf == 0 {
		return false, fail
	}
	vb := *(*uintptr)(unsafe.Pointer(buf))
	// StretchRect(back, NULL, scratch, NULL, D3DTEXF_NONE=0)
	if hr := call6(d.vdev+devRectToRect*ptrSize, d.dev, buf, 0, d.surf, 0, 0); hr != 0 {
		call3(vb+surfRelease*ptrSize, buf, 0, 0)
		return false, fail
	}
	call3(vb+surfRelease*ptrSize, buf, 0, 0)
	var lr d3d9LockedRect
	// LockRect(&lr, NULL, D3DLOCK_READONLY=0x200, 0)
	if hr := call6(slot(d.surf, surfLock), d.surf, uintptr(unsafe.Pointer(&lr)), 0, 0x200, 0, 0); hr != 0 {
		return false, fail
	}
	stride := int(lr.Pitch)
	changed := false
	if stride > 0 && lr.pBits != nil {
		src := unsafe.Slice(lr.pBits, stride*dh)
		row := dw * 4
		if stride < row {
			row = stride
		}
		for y := 0; y < dh; y++ {
			a := dst[y*row : y*row+row]
			b := src[y*stride : y*stride+row]
			if !changed && !bytes.Equal(a, b) {
				changed = true
			}
			copy(a, b)
		}
	}
	call3(slot(d.surf, surfUnlock), d.surf, 0, 0)
	if !changed {
		return false, nil
	}
	d.prev = append(d.prev[:0], dst...)
	return true, nil
}

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
// session instantly made those look like crashes. The session no longer ends
// when the window closes: as long as the Default desktop keeps compositing,
// frames still reach the viewer through the GDI or Direct3D9 capture path —
// only a full lock or sign-out (which stops composition entirely) ends it.
const secureDesktopGrace = 5 * time.Minute

var nonDefaultSince time.Time

// desktopAllowed reports whether it is fine to keep streaming right now. The
// first time input leaves the Default desktop it starts a grace window: the
// screen keeps updating (the Default desktop stays composed behind the
// overlay) so brief switches do not drop the connection. After the window the
// stream continues too; this function then only returns false once even the
// compositor has gone quiet for good (lock screens), which grab surfaces as a
// capture error anyway.
func desktopAllowed() bool {
	if onDefaultDesktop() {
		nonDefaultSince = time.Time{}
		return true
	}
	if nonDefaultSince.IsZero() {
		nonDefaultSince = time.Now()
	}
	return time.Since(nonDefaultSince) < secureDesktopGrace || composing()
}

// composing reports whether the desktop compositor is still producing frames
// on the interactive window station — i.e. the machine is not sitting on the
// lock/sign-in screen. It opens the Default desktop of the current window
// station and checks its flags via GetUserObjectInformation.
func composing() bool {
	d, _, _ := openDesktop.Call(0, 0, 1) // OPEN_INPUT_DESKTOP / READ_CONTROL
	if d == 0 {
		return false
	}
	defer closeDesktop.Call(d)
	var flags uint32
	var size uint32
	// UOI_FLAGS == 1; DESKTOP_SWITCHDESKTOP (0x0100) is set only on desktops
	// that can be brought forward, which excludes the disconnected/winlogon
	// secure desktop states we must not keep "streaming" forever.
	ok, _, _ := getObjectInfo.Call(d, 1, uintptr(unsafe.Pointer(&flags)), 4, uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return false
	}
	return flags&0x0100 != 0
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
	dx                    dxCapturer  // Direct3D9 fallback path (see grabDX)
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

// grabDX is the alternate capture path used when the GDI screen DC stops
// showing new content — typical once a fullscreen or exam-lockdown app takes
// over the display. It reads the Direct3D9 composited back buffer instead.
// Like grab it returns the shared frame and the changed regions (nil when the
// desktop has not moved), and an error only when nothing at all can be read.
func (c *capturer) grabDX() (*image.RGBA, int, int, []image.Rectangle, error) {
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
	bgra := unsafe.Slice(c.pixel, c.dw*c.dh*4)
	full := image.Rect(0, 0, c.dw, c.dh)
	changed, err := c.dx.grab(bgra, c.dw, c.dh)
	if err != nil {
		return nil, 0, 0, nil, err
	}
	var rects []image.Rectangle
	if fresh || c.img == nil {
		c.prev = make([]byte, len(bgra))
		copy(c.prev, bgra)
		c.img = image.NewRGBA(full)
		rects = []image.Rectangle{full}
	} else if !changed {
		// The compositor echoed the previous frame: report "nothing new" so
		// the caller keeps pacing without re-sending stale pixels.
		return c.img, w, h, nil, nil
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

// releaseDX frees the Direct3D objects held by the fallback path.
func (c *capturer) releaseDX() { c.dx.dispose() }

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
