// SPDX-License-Identifier: AGPL-3.0-only
package fdrivelease

import (
	"sync"
	"testing"
	"time"
)

func TestOpenWritersBlockAcquireAndTokensAreOwnerBound(t *testing.T) {
	m := New(time.Now)
	done, err := m.Begin("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Acquire("alice"); err == nil {
		t.Fatal("acquired over open writer")
	}
	done()
	done()
	token, err := m.Acquire("alice")
	if err != nil {
		t.Fatal(err)
	}
	if m.Validate(token, "bob") || m.Validate("unknown", "alice") {
		t.Fatal("accepted wrong owner or token")
	}
	if _, err = m.Begin(""); err == nil {
		t.Fatal("ordinary writer bypassed lease")
	}
	if err = m.Renew(token, "bob"); err == nil {
		t.Fatal("another user renewed lease")
	}
	if err = m.Release(token, "bob"); err == nil {
		t.Fatal("another user released lease")
	}
	if err = m.Release(token, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Begin(token); err == nil {
		t.Fatal("released token was accepted")
	}
}

func TestExpiryAndReleaseDrainAdmittedHandlesBeforeNewWriters(t *testing.T) {
	for _, release := range []bool{false, true} {
		now := time.Now()
		m := New(func() time.Time { return now })
		token, _ := m.Acquire("alice")
		done, err := m.Begin(token)
		if err != nil {
			t.Fatal(err)
		}
		if release {
			_ = m.Release(token, "alice")
		} else {
			now = now.Add(Duration)
		}
		if m.Check(token) == nil {
			t.Fatal("expired token remains valid")
		}
		if _, err = m.Begin(""); err == nil {
			t.Fatal("ordinary write entered before handle drained")
		}
		if _, err = m.Acquire("bob"); err == nil {
			t.Fatal("new lease entered before handle drained")
		}
		done()
		next, err := m.Acquire("bob")
		if err != nil {
			t.Fatal(err)
		}
		if next == token {
			t.Fatal("lease generation reused")
		}
		if _, err = m.Begin(token); err == nil {
			t.Fatal("old writer fenced incorrectly")
		}
		if err = m.Renew(token, "alice"); err == nil {
			t.Fatal("old lease renewed")
		}
	}
}

func TestConcurrentAcquisitionHasOneWinner(t *testing.T) {
	m := New(time.Now)
	var wg sync.WaitGroup
	results := make(chan bool, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := m.Acquire("alice"); results <- err == nil }()
	}
	wg.Wait()
	close(results)
	wins := 0
	for ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("%d simultaneous owners", wins)
	}
}

func TestRenewalCannotReviveExpiredLease(t *testing.T) {
	now := time.Now()
	m := New(func() time.Time { return now })
	token, _ := m.Acquire("alice")
	now = now.Add(Duration / 2)
	if err := m.Renew(token, "alice"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(Duration / 2)
	if !m.Validate(token, "alice") {
		t.Fatal("renewed lease expired too early")
	}
	now = now.Add(Duration)
	if m.Renew(token, "alice") == nil {
		t.Fatal("revived expired lease")
	}
}
