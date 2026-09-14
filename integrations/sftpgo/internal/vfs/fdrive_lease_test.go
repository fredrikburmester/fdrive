// SPDX-License-Identifier: AGPL-3.0-only
package vfs

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
	"github.com/sftpgo/sdk"
)

func TestFdriveOpenWriterAndStalePublication(t *testing.T) {
	t.Setenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT", fdrivelease.Protocol)
	root := t.TempDir()
	original := filepath.Join(root, "original")
	stage := filepath.Join(root, "stage")
	ordinary := NewOsFs("peer", root, "", &sdk.OSFsConfig{WriteBufferSize: 1})
	f, pipe, _, err := ordinary.Create(original, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if pipe != nil {
		t.Fatal("write buffering escaped handle accounting")
	}
	if _, err = fdrivelease.Global.Acquire("alice"); err == nil {
		t.Fatal("acquired over an open file")
	}
	_, _ = f.Write([]byte("original"))
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	token, err := fdrivelease.Global.Acquire("alice")
	if err != nil {
		t.Fatal(err)
	}
	defer fdrivelease.Global.Release(token, "alice")
	scoped := NewOsFs("native", root, "", nil)
	if err = BindFdriveLease(scoped, token); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = ordinary.Create(original, 0, 0); err == nil {
		t.Fatal("ordinary overwrite allowed")
	}
	if err = ordinary.Truncate(original, 0); err == nil {
		t.Fatal("ordinary truncate allowed")
	}
	if _, _, err = ordinary.Rename(original, stage, 0); err == nil {
		t.Fatal("ordinary rename allowed")
	}
	if err = ordinary.Remove(original, false); err == nil {
		t.Fatal("ordinary removal allowed")
	}
	if err = ordinary.Mkdir(filepath.Join(root, "dir")); err == nil {
		t.Fatal("ordinary mkdir allowed")
	}
	f, _, _, err = scoped.Create(stage, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("new"))
	if err = fdrivelease.Global.Release(token, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Write([]byte("stale")); err == nil {
		t.Fatal("released writer still writes")
	}
	if _, _, _, err = ordinary.Create(original, 0, 0); err == nil {
		t.Fatal("new writer entered before close")
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err = scoped.Rename(stage, original, 0); err == nil {
		t.Fatal("released token published")
	}
	bytes, _ := os.ReadFile(original)
	if string(bytes) != "original" {
		t.Fatalf("lost original: %s", bytes)
	}
	next, err := fdrivelease.Global.Acquire("alice")
	if err != nil {
		t.Fatal(err)
	}
	defer fdrivelease.Global.Release(next, "alice")
	if err = BindFdriveLease(scoped, next); err != nil {
		t.Fatal(err)
	}
	if _, _, err = scoped.Rename(stage, original, 0); err != nil {
		t.Fatal(err)
	}
	bytes, _ = os.ReadFile(original)
	if string(bytes) != "new" {
		t.Fatalf("bad publication: %s", bytes)
	}
}

func TestFdriveMetadataAndEncryptedAliasesCannotBypass(t *testing.T) {
	t.Setenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT", fdrivelease.Protocol)
	root := t.TempDir()
	name := filepath.Join(root, "original")
	if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	token, err := fdrivelease.Global.Acquire("alice")
	if err != nil {
		t.Fatal(err)
	}
	defer fdrivelease.Global.Release(token, "alice")
	peer := NewOsFs("alias", root, "", nil)
	for _, mutate := range []func() error{
		func() error { return peer.Chmod(name, 0777) },
		func() error { return peer.Chown(name, os.Getuid(), os.Getgid()) },
		func() error { return peer.Chtimes(name, time.Now(), time.Now(), false) },
		func() error { return peer.Symlink(name, filepath.Join(root, "link")) },
	} {
		if !os.IsPermission(mutate()) {
			t.Fatal("metadata mutation bypassed lease")
		}
	}
	missing := NewOsFs("missing", filepath.Join(root, "missing"), "", nil)
	if missing.CheckRootPath("peer", os.Getuid(), os.Getgid()) {
		t.Fatal("root creation bypassed lease")
	}
	if _, err := NewCryptFs("crypt", root, "", CryptFsConfig{}); err == nil {
		t.Fatal("encrypted alias accepted")
	}
}

func TestFdriveCrossDevicePublicationNeverCopies(t *testing.T) {
	t.Setenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT", fdrivelease.Protocol)
	root := t.TempDir()
	targetRoot, err := os.MkdirTemp("/dev/shm", "fdrive-rename-")
	if err != nil {
		t.Fatal(err)
	} // This test runs in the Linux image build.
	defer os.RemoveAll(targetRoot)
	source, target := filepath.Join(root, "stage"), filepath.Join(targetRoot, "target")
	if err := os.WriteFile(source, []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	token, err := fdrivelease.Global.Acquire("alice")
	if err != nil {
		t.Fatal(err)
	}
	defer fdrivelease.Global.Release(token, "alice")
	scoped := NewOsFs("native", root, "", nil)
	if err := BindFdriveLease(scoped, token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := scoped.Rename(source, target, 0); !isCrossDeviceError(err) {
		t.Fatalf("expected EXDEV, got %v", err)
	}
	if bytes, err := os.ReadFile(source); err != nil || string(bytes) != "retained" {
		t.Fatal("staging bytes lost")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("cross-device target was published")
	}
}
