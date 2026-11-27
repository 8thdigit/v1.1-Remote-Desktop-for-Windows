package main

import (
	"context"
	"errors"
	"image"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

type sessionUpdate struct {
	state, text, code string
}

func run(parent context.Context, r *relay, lines <-chan string, updates chan<- sessionUpdate) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go func() {
		t := time.NewTicker(25 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if stopPressed() {
					cancel()
					return
				}
			}
		}
	}()
	var invitation invite
	if err := r.post(ctx, "invite", nil, &invitation); err != nil {
		return err
	}
	if !codeFormat.MatchString(invitation.Code) || !tokenFormat.MatchString(invitation.Token) {
		return errors.New("relay returned an invalid invitation")
	}
	r.token = invitation.Token
	defer func() {
		endCtx, stop := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer stop()
		_ = r.post(endCtx, "end", nil, nil)
	}()
	updates <- sessionUpdate{state: "waiting", text: "Share this one-time code with your helper. It expires in 3 minutes.", code: invitation.Code[:4] + "-" + invitation.Code[4:8] + "-" + invitation.Code[8:]}
	wait := time.NewTicker(650 * time.Millisecond)
	defer wait.Stop()
	challenge := ""
	for {
		var reply tick
		if err := r.post(ctx, "tick", nil, &reply); err != nil {
			return err
		}
		if reply.State == "pending" && challenge == "" {
			if !verifyFormat.MatchString(reply.Verification) {
				return errors.New("invalid verification number")
			}
			challenge = reply.Verification
			updates <- sessionUpdate{state: "pending", text: "A helper requested access. Enter the 6-digit number they see, then approve or decline."}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case typed, ok := <-lines:
			if !ok || challenge == "" || typed != challenge {
				return errors.New("verification did not match; no screen was shared")
			}
			if !onDefaultDesktop() {
				return errors.New("unlock Windows before starting support")
			}
			ready := make(chan error, 1)
			indicatorDone := make(chan struct{})
			go func() {
				defer close(indicatorDone)
				showSharingIndicator(ctx, cancel, ready)
			}()
			defer func() { cancel(); <-indicatorDone }()
			if err := <-ready; err != nil {
				return err
			}
			if err := r.post(ctx, "approve", nil, nil); err != nil {
				return err
			}
			updates <- sessionUpdate{state: "live", text: "Live: screen sharing and remote control are active. Ctrl+2 or F12 stops the session."}
			return stream(ctx, r)
		case <-wait.C:
		}
	}
}

// stream shares the screen and applies remote input until the session ends.
// Screen updates and input travel separately: the screen loop uploads only
// the regions that changed, as fast as the link allows (two uploads in
// flight on relays that put them back in order), while input arrives on its
// own channel (streamed where the relay can) and is applied the moment it
// lands. A dropped request is retried for a while instead of ending the
// session.
func stream(ctx context.Context, r *relay) error {
	ctx, cancel := context.WithCancel(ctx)
	input := newControls()
	var inputMu sync.Mutex
	defer func() {
		// Stop the input channel first, so nothing is pressed after release.
		cancel()
		inputMu.Lock()
		input.release()
		inputMu.Unlock()
	}()
	pace := newPacer()
	screen := newCapturer()
	defer screen.close()
	defer screen.releaseDX()
	gdiStill, dxPathOn = 0, false
	screen.limit(pace.prof.maxW, pace.prof.maxH)
	frame, w, h, rects, err := screen.grab()
	if err != nil {
		return err
	}
	apply := func(list []event) error {
		inputMu.Lock()
		defer inputMu.Unlock()
		for _, a := range list {
			if ctx.Err() != nil || stopPressed() {
				return context.Canceled
			}
			input.apply(a, w, h)
		}
		if time.Since(input.lastPointer) > 3*time.Second {
			input.release()
		}
		return nil
	}

	// The input channel: streamed where the relay can, long-polled where
	// it cannot. A relay without /events answers 404; input then comes with
	// each tick, as before.
	var eventsOn atomic.Bool
	inputDone := make(chan error, 1)
	go func() {
		stop := func(err error) {
			inputDone <- err
			cancel()
		}
		onReply := func(reply tick) error {
			if reply.State != "live" {
				return errors.New("relay ended the approved session")
			}
			eventsOn.Store(true)
			return apply(reply.Input)
		}
		streaming := true
		var failingSince time.Time
		for ctx.Err() == nil {
			var err error
			if streaming {
				err = r.eventStream(ctx, onReply)
				if errors.Is(err, errNoStream) {
					streaming = false
					continue
				}
			} else {
				var reply tick
				wait := 4 * time.Second
				if !eventsOn.Load() {
					wait = 0
				}
				if err = r.events(ctx, wait, &reply); err == nil {
					err = onReply(reply)
				}
			}
			if err == nil {
				failingSince = time.Time{}
				continue
			}
			var status *statusError
			switch {
			case ctx.Err() != nil:
				return
			case errors.As(err, &status) && status.status == 404 && !eventsOn.Load():
				inputDone <- nil // an older relay: input comes with ticks
				return
			case errors.Is(err, context.Canceled), err.Error() == "relay ended the approved session":
				stop(err)
				return
			case errors.As(err, &status) && status.status != 429 && status.status < 500:
				stop(err)
				return
			}
			// A network hiccup: try again for a while.
			if failingSince.IsZero() {
				failingSince = time.Now()
			} else if time.Since(failingSince) > retryFor {
				stop(err)
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(300 * time.Millisecond):
			}
		}
	}()
	fail := func(err error) error {
		// Prefer the input channel's reason when it stopped the session.
		select {
		case inErr := <-inputDone:
			if inErr != nil {
				return inErr
			}
		default:
		}
		return err
	}

	type result struct {
		reply tick
		err   error
		sent  int
		took  time.Duration
	}
	results := make(chan result, 4)
	inFlight := 0
	var seq uint64
	deadline := time.Now().Add(30 * time.Minute)
	patches := false  // the relay accepts patches (learned from its replies)
	pipeline := false // the relay orders numbered ticks
	needKey := true   // the next update must be a keyframe
	refine := false   // patches were sent since the last keyframe
	var keyBytes, sinceKey int
	var lastChange, lastTick, failingSince time.Time
	// handle takes the answer to one upload.
	handle := func(res result) error {
		inFlight--
		if res.err != nil {
			var status *statusError
			if errors.As(res.err, &status) && status.status != 429 && status.status < 500 && status.status != 413 {
				return res.err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A network hiccup: the upload is lost, so the viewer needs a
			// whole new screen. Keep going for a while before giving up.
			needKey = true
			if failingSince.IsZero() {
				failingSince = time.Now()
			} else if time.Since(failingSince) > retryFor {
				return res.err
			}
			pace.observe(1, slowRTT*2)
			return nil
		}
		failingSince = time.Time{}
		pace.observe(res.sent, res.took)
		reply := res.reply
		if reply.State != "live" {
			return errors.New("relay ended the approved session")
		}
		// A relay that does not know patches never says so; it is sent
		// keyframes only.
		if reply.Patches {
			patches = true
		}
		if reply.Pipeline {
			pipeline = true
		}
		if reply.Key {
			needKey = true
		}
		if reply.Quality != "" && pace.setProfile(reply.Quality) {
			screen.limit(pace.prof.maxW, pace.prof.maxH)
			needKey = true
		}
		if len(reply.Input) > 0 {
			return apply(reply.Input)
		}
		return nil
	}
	for {
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		if time.Now().After(deadline) {
			return errors.New("the 30-minute session limit was reached")
		}
		started := time.Now()
		if rects != nil {
			lastChange = started
		}
		// Take the answers that came in.
	drain:
		for {
			select {
			case res := <-results:
				if err := handle(res); err != nil {
					return fail(err)
				}
			default:
				break drain
			}
		}
		heartbeat := 200 * time.Millisecond
		if eventsOn.Load() {
			heartbeat = time.Second
		}
		// Once the screen settles, replace the patches with a sharper
		// keyframe so their edges and low-quality blocks clear.
		settle := rects == nil && refine && patches && started.Sub(lastChange) > 800*time.Millisecond
		if rects != nil || needKey || settle || time.Since(lastTick) >= heartbeat {
			// Wait for a free upload slot, taking answers meanwhile.
			limit := 1
			if pipeline {
				limit = 2
			}
			for inFlight >= limit {
				select {
				case <-ctx.Done():
					return fail(ctx.Err())
				case res := <-results:
					if err := handle(res); err != nil {
						return fail(err)
					}
				}
			}
			// Decide what to send: a keyframe when one is due, the changed
			// regions otherwise, or nothing (a heartbeat).
			size := 3 << 20 // what the relay takes in one upload
			if !pipeline {
				size = 1400 << 10 // relays before pipelining take 1.5 MB
			}
			if !patches {
				size = 700 << 10 // older relays take a bare JPEG up to 768 KB
			}
			quality, subsample := pace.quality(), pace.prof.subsample
			key := needKey || !patches || (rects != nil && totalArea(rects, frame.Rect.Dx(), frame.Rect.Dy()) > keyArea) ||
				(rects != nil && keyBytes > 0 && sinceKey > 2*keyBytes)
			if rects == nil && !needKey {
				key = settle
				if settle {
					quality = pace.refineQuality()
				}
			}
			var list []update
			if key {
				data, err := encodeJPEG(frame, quality, subsample, size)
				if err != nil {
					return err
				}
				list = []update{{key: true, jpeg: data}}
			} else if rects != nil {
				for _, rc := range rects {
					data, err := encodeJPEG(frame.SubImage(rc), quality, subsample, size)
					if err != nil {
						return err
					}
					list = append(list, update{x: rc.Min.X, y: rc.Min.Y, jpeg: data})
				}
			}
			var body []byte
			contentType := "application/x-msfwr-frames"
			switch {
			case len(list) == 0:
			case patches:
				body = packUpdates(list)
				if !list[0].key && len(body) > size {
					// Too many changes for one upload: send the whole screen.
					data, err := encodeJPEG(frame, quality, subsample, size)
					if err != nil {
						return err
					}
					list = []update{{key: true, jpeg: data}}
					body = packUpdates(list)
				}
			default:
				// A relay without patches takes a bare JPEG keyframe.
				body, contentType = list[0].jpeg, "image/jpeg"
			}
			if len(list) > 0 {
				if list[0].key {
					keyBytes, sinceKey = len(body), 0
					refine = false
				} else {
					sinceKey += len(body)
					refine = true
				}
				needKey = false
			}
			seq++
			inFlight++
			lastTick = time.Now()
			go func(body []byte, contentType string, seq uint64) {
				var reply tick
				t0 := time.Now()
				err := r.tickSeq(ctx, body, contentType, eventsOn.Load(), seq, &reply)
				results <- result{reply: reply, err: err, sent: len(body), took: time.Since(t0)}
			}(body, contentType, seq)
		}
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		if !desktopAllowed() {
			return errors.New("Windows switched to a locked or protected desktop")
		}
		if !sameScreen(w, h) {
			return errors.New("Windows desktop or display configuration changed")
		}
		// Older relays ignore frames closer than 100 ms apart.
		gap := pace.gap
		if !patches && gap < 100*time.Millisecond {
			gap = 100 * time.Millisecond
		}
		if rects == nil {
			// Nothing changed: look again soon, so a change shows quickly.
			gap = minGap
		}
		if wait := gap - time.Since(started); wait > 0 {
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return fail(ctx.Err())
			case res := <-results:
				t.Stop()
				if err := handle(res); err != nil {
					return fail(err)
				}
				// Wait out the rest of the gap.
				if rest := gap - time.Since(started); rest > 0 {
					select {
					case <-ctx.Done():
						return fail(ctx.Err())
					case <-time.After(rest):
					}
				}
			case <-t.C:
			}
		}
		frame, _, _, rects, err = grabTracked(screen)
		if err != nil {
			return err
		}
	}
}

// The stream normally reads the screen through a GDI DC. Fullscreen and
// exam-lockdown apps can stop that DC from showing new content while the
// desktop itself keeps compositing; when GDI reports no changes for a few
// frames in a row we switch to reading the composited desktop through
// Direct3D9 so the video keeps flowing, and switch back as soon as GDI sees
// motion again.
const gdiQuietFrames = 4

var (
	gdiStill   int
	dxPathOn   bool
	lastFrames []*image.RGBA // keep D3D scratch alive across grabs
)

func grabTracked(screen *capturer) (*image.RGBA, int, int, []image.Rectangle, error) {
	keep := func(img *image.RGBA, rects []image.Rectangle) {
		lastFrames = lastFrames[:0]
		if img != nil {
			lastFrames = append(lastFrames, img)
		}
		_ = rects
	}
	if !dxPathOn {
		frame, w, h, rects, err := screen.grab()
		if err != nil {
			return nil, 0, 0, nil, err
		}
		keep(frame, rects)
		if rects == nil {
			gdiStill++
		} else {
			gdiStill = 0
		}
		if gdiStill >= gdiQuietFrames {
			dxPathOn = true // tried on the next grab; reset if it fails
		}
		return frame, w, h, rects, nil
	}
	frame, w, h, rects, err := screen.grabDX()
	if err != nil {
		// D3D unavailable: stay on the GDI path instead of ending the session.
		dxPathOn, gdiStill = false, 0
		return screen.grab()
	}
	keep(frame, rects)
	if rects != nil {
		gdiStill = 0
	}
	return frame, w, h, rects, nil
}

// retryFor is how long the PC keeps trying through network hiccups before
// it ends the session.
const retryFor = 12 * time.Second

type unattendedUpdate struct {
	state, text string // state is ready, calling, connected, offline or locked
	// link updates only report on the remote access URL (text); they do not
	// change the state.
	link bool
	// ra updates report what the relay knows about the RA ID.
	ra               bool
	raStatus, raName string
}

// callTTL matches callTTL in artifacts/api-server/src/lib/msfwr.ts.
const callTTL = 2 * time.Minute

// serveUnattended keeps a pre-approved registration open on the relay and
// streams to the first viewer that joins with this PC's saved access code,
// through the company its RA ID points to, or through its remote access
// URL. There is no approval prompt; the Msfwr window shows the state.
// Ctrl+2, F12 or "Stop current session" end a live session; the host then
// registers again for the next one. Initiate asks IT to connect: the company
// behind the RA ID, and browsers that saved this PC's code, see the request.
// raOf returns the current RA ID; a value on reregister makes the host
// register again at once (for example after the RA ID changed).
func serveUnattended(ctx context.Context, origin, key, name, license, linksPath string, raOf func() string, reregister, stopSession, initiate <-chan struct{}, updates chan<- unattendedUpdate) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	backoff := 2 * time.Second
	pause := func(d time.Duration) bool {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-reregister:
			return true
		case <-t.C:
			return true
		}
	}
	var callUntil time.Time
	for ctx.Err() == nil {
		if !onDefaultDesktop() {
			callUntil = time.Time{}
			updates <- unattendedUpdate{state: "locked", text: "Windows is locked. Remote access resumes after you sign in."}
			if !pause(3 * time.Second) {
				return
			}
			continue
		}
		served, err := unattendedRound(ctx, origin, key, name, license, raOf(), linksPath, reregister, stopSession, initiate, &callUntil, updates)
		if ctx.Err() != nil {
			return
		}
		if served || err != nil {
			callUntil = time.Time{}
		}
		if served {
			text := "Remote session ended. Ready for the next connection."
			if err != nil && !errors.Is(err, context.Canceled) {
				text = "Remote session ended: " + err.Error()
			}
			updates <- unattendedUpdate{state: "ready", text: text}
			backoff = 2 * time.Second
			continue
		}
		if err == nil {
			backoff = 2 * time.Second
			continue
		}
		// A subscription refusal is not a lost relay: show why and wait,
		// without a tight retry. The relay re-checks on the next round.
		if text, blocked := subscriptionBlocked(err); blocked {
			updates <- unattendedUpdate{state: "offline", text: text}
			if !pause(30 * time.Second) {
				return
			}
			continue
		}
		updates <- unattendedUpdate{state: "offline", text: "Cannot reach the relay (" + err.Error() + "). Retrying…"}
		if !pause(backoff) {
			return
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

// unattendedRound registers once and waits up to two minutes for a viewer
// before returning so the caller can refresh the registration. served reports
// whether a viewer connected.
// callUntil is when the current Initiate request lapses; it survives the
// registration refresh so a request is not lost when the round restarts.
func unattendedRound(parent context.Context, origin, key, name, license, ra, linksPath string, reregister, stopSession, initiate <-chan struct{}, callUntil *time.Time, updates chan<- unattendedUpdate) (served bool, err error) {
	r, err := newRelay(origin)
	if err != nil {
		return false, err
	}
	var invitation invite
	body := standingBody(unattendedConfig{Key: key, RA: ra, License: license}, name)
	if err := r.postJSON(parent, "standing", body, &invitation); err != nil {
		return false, err
	}
	if invitation.Code != standingCode(key) || !tokenFormat.MatchString(invitation.Token) {
		return false, errors.New("relay returned an invalid registration")
	}
	updates <- unattendedUpdate{ra: true, raStatus: invitation.RaStatus, raName: invitation.RaName}
	r.token = invitation.Token
	defer func() {
		endCtx, stop := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer stop()
		_ = r.post(endCtx, "end", nil, nil)
	}()
	// Keep this PC's remote access URL alive on the relay, which forgets
	// links when it restarts. A link the relay says expired is dropped here.
	if l, _ := loadLink(linksPath, time.Now()); l != nil {
		lctx, cancel := context.WithTimeout(parent, 6*time.Second)
		err := r.restoreLink(lctx, *l)
		cancel()
		var status *statusError
		if errors.As(err, &status) && status.status == 410 {
			if current, _ := loadLink(linksPath, time.Now()); current != nil && current.ID == l.ID {
				_ = forgetLink(linksPath)
				updates <- unattendedUpdate{link: true, text: "The remote access URL expired. Create a new one if you need it."}
			}
		}
	}
	call := func(until time.Time) error {
		if err := r.postJSON(parent, "call", map[string]string{"name": name}, nil); err != nil {
			// A relay that answers but rejects the request (an older build
			// without Initiate, or the session is no longer waiting) is not
			// a network failure: say so and keep the registration.
			if text, ok := initiateRejected(err); ok {
				*callUntil = time.Time{}
				updates <- unattendedUpdate{state: "ready", text: text}
				return nil
			}
			return err
		}
		*callUntil = until
		to := "IT"
		if invitation.RaStatus == "ok" && invitation.RaName != "" {
			to = invitation.RaName
		}
		updates <- unattendedUpdate{state: "calling", text: "Request sent. Waiting for " + to + " to accept in the browser…"}
		return nil
	}
	if time.Now().Before(*callUntil) {
		if err := call(*callUntil); err != nil {
			return false, err
		}
	} else {
		updates <- unattendedUpdate{state: "ready", text: "Ready. IT can connect with this PC's access code, or select Initiate."}
	}
	refresh := time.Now().Add(2 * time.Minute)
	wait := time.NewTicker(650 * time.Millisecond)
	defer wait.Stop()
	for time.Now().Before(refresh) {
		var reply tick
		if err := r.post(parent, "tick", nil, &reply); err != nil {
			return false, err
		}
		switch reply.State {
		case "waiting":
			if !callUntil.IsZero() && time.Now().After(*callUntil) {
				*callUntil = time.Time{}
				updates <- unattendedUpdate{state: "ready", text: "No one accepted the request. Select Initiate to ask again."}
			}
		case "live":
			if !onDefaultDesktop() {
				return false, nil
			}
			ctx, cancel := context.WithCancel(parent)
			defer cancel()
			go func() {
				t := time.NewTicker(25 * time.Millisecond)
				defer t.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-stopSession:
						cancel()
						return
					case <-t.C:
						if stopPressed() {
							cancel()
							return
						}
					}
				}
			}()
			*callUntil = time.Time{}
			updates <- unattendedUpdate{state: "connected", text: "IT can view and control this PC. Press Ctrl+2 or F12 to stop."}
			return true, stream(ctx, r)
		default:
			return false, errors.New("relay returned an unexpected state")
		}
		select {
		case <-parent.Done():
			return false, parent.Err()
		case <-reregister:
			return false, nil
		case <-stopSession:
			// Nothing is live; ignore a stale stop request.
		case <-initiate:
			if err := call(time.Now().Add(callTTL)); err != nil {
				return false, err
			}
		case <-wait.C:
		}
	}
	return false, nil
}
