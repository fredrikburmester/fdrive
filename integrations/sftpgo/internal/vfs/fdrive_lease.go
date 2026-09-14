// SPDX-License-Identifier: AGPL-3.0-only
package vfs

import (
	"os"
	"sync"

	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
)

// BindFdriveLease is called only after the HTTP layer validates both the lease
// and its authenticated owner. It never grants filesystem permissions.
func BindFdriveLease(fs Fs, token string) error {
	if token == "" {
		return nil
	}
	local, ok := fs.(*OsFs)
	if !ok || !fdrivelease.Enabled() {
		return os.ErrPermission
	}
	local.fdriveLease = token
	return nil
}

func (fs *OsFs) beginFdriveWrite() (func(), error) {
	if !fdrivelease.Enabled() {
		return func() {}, nil
	}
	done, err := fdrivelease.Global.Begin(fs.fdriveLease)
	if err != nil {
		return nil, os.ErrPermission
	}
	return done, nil
}

// Buffering is disabled in the opt-in mode: a Close must mean the last backend
// write has finished. The ordinary read path is unchanged.
func (fs *OsFs) createFdriveFile(name string, flag int) (File, PipeWriter, func(), error) {
	done, err := fs.beginFdriveWrite()
	if err != nil {
		return nil, nil, nil, err
	}
	if flag == 0 {
		flag = os.O_RDWR | os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(name, flag, 0666)
	if err != nil {
		done()
		return nil, nil, nil, err
	}
	return &fdriveFile{File: f, token: fs.fdriveLease, done: done}, nil, nil, nil
}

type fdriveFile struct {
	File
	token    string
	done     func()
	once     sync.Once
	closeErr error
}

func (f *fdriveFile) check() error {
	if f.token != "" && fdrivelease.Global.Check(f.token) != nil {
		return os.ErrPermission
	}
	return nil
}
func (f *fdriveFile) Write(p []byte) (int, error) {
	if err := f.check(); err != nil {
		return 0, err
	}
	return f.File.Write(p)
}
func (f *fdriveFile) WriteAt(p []byte, off int64) (int, error) {
	if err := f.check(); err != nil {
		return 0, err
	}
	return f.File.WriteAt(p, off)
}
func (f *fdriveFile) Truncate(size int64) error {
	if err := f.check(); err != nil {
		return err
	}
	return f.File.Truncate(size)
}
func (f *fdriveFile) Close() error {
	f.once.Do(func() {
		// Sync leased uploads before acknowledging the body; keep exclusion until
		// the actual descriptor has closed even if synchronization fails.
		if f.token != "" {
			f.closeErr = f.File.(*os.File).Sync()
		}
		if err := f.File.Close(); f.closeErr == nil {
			f.closeErr = err
		}
		f.done()
	})
	return f.closeErr
}
