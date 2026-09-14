// SPDX-License-Identifier: AGPL-3.0-only
// Optional fdrive integration for the pinned SFTPGo source. No SFTPGo credentials
// or permission checks are replaced by this storage mutation gate.
package fdrivelease

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"sync"
	"time"
)

const Protocol = "fdrive-local-v1"
const Header = "X-Fdrive-Write-Lease"
const Duration = 60 * time.Second

var ErrLocked = errors.New("storage write lease is unavailable or expired")
var Global = New(time.Now)

func Enabled() bool { return os.Getenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT") == Protocol }

func Allowed(username string) bool {
	if !Enabled() || username == "" {
		return false
	}
	for _, name := range strings.Split(os.Getenv("FDRIVE_SFTPGO_WRITE_USERS"), ",") {
		if strings.TrimSpace(name) == username {
			return true
		}
	}
	return false
}

// Manager covers every local filesystem home in this process, including aliases
// shared by different users. An open writer counts until its handle is closed.
// Expiration fences new calls immediately, but never releases exclusion while
// an already admitted call/handle can still mutate storage.
type Manager struct {
	mu           sync.Mutex
	now          func() time.Time
	token, owner string
	expires      time.Time
	active       int
}

func New(now func() time.Time) *Manager { return &Manager{now: now} }

func (m *Manager) reap() {
	if m.active == 0 && !m.now().Before(m.expires) {
		m.token, m.owner = "", ""
	}
}

func (m *Manager) valid(token string) bool {
	return token != "" && m.now().Before(m.expires) && subtle.ConstantTimeCompare([]byte(m.token), []byte(token)) == 1
}

func (m *Manager) Acquire(owner string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reap()
	if owner == "" || m.token != "" || m.active != 0 {
		return "", ErrLocked
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	m.token, m.owner, m.expires = hex.EncodeToString(nonce[:]), owner, m.now().Add(Duration)
	return m.token, nil
}

func (m *Manager) Validate(token, owner string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return owner == m.owner && m.valid(token)
}

func (m *Manager) Check(token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.valid(token) {
		return ErrLocked
	}
	return nil
}

func (m *Manager) Renew(token, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner != m.owner || !m.valid(token) {
		return ErrLocked
	}
	m.expires = m.now().Add(Duration)
	return nil
}

func (m *Manager) Release(token, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner != m.owner || !m.valid(token) {
		return ErrLocked
	}
	m.expires = time.Time{}
	m.reap()
	return nil
}

func (m *Manager) Begin(token string) (func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reap()
	if (token == "" && m.token != "") || (token != "" && !m.valid(token)) {
		return nil, ErrLocked
	}
	m.active++
	var once sync.Once
	return func() { once.Do(func() { m.mu.Lock(); defer m.mu.Unlock(); m.active--; m.reap() }) }, nil
}
