// SPDX-License-Identifier: AGPL-3.0-only
package config

import (
	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
	"testing"
)

func TestFdriveUnsafeConfiguration(t *testing.T) {
	original := globalConf
	defer func() { globalConf = original }()
	t.Setenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT", fdrivelease.Protocol)
	Init()
	if err := validateFdriveEnforcement(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(){
		func() { globalConf.Common.StartupHook = "/bin/true" },
		func() { globalConf.ProviderConf.PreLoginHook = "http://example.test" },
		func() { globalConf.Common.EventManager.EnabledCommands = []string{"*"} },
		func() { globalConf.SFTPD.EnabledSSHCommands = []string{"rsync"} },
		func() { globalConf.ProviderConf.IsShared = 1 },
	} {
		Init()
		mutate()
		if validateFdriveEnforcement() == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
	t.Setenv("FDRIVE_SFTPGO_WRITE_ENFORCEMENT", "")
	if err := validateFdriveEnforcement(); err != nil {
		t.Fatal(err)
	}
}
