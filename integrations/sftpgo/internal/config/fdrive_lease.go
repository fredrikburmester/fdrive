// SPDX-License-Identifier: AGPL-3.0-only
package config

import (
	"fmt"
	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
)

// Executable hooks/plugins can write outside Fs. The mount must also be exclusive
// to this process; enabling leases is an explicit deployment qualification.
func validateFdriveEnforcement() error {
	if !fdrivelease.Enabled() {
		return nil
	}
	c := globalConf
	hooks := []string{
		c.Common.Actions.Hook, c.Common.StartupHook, c.Common.PostConnectHook, c.Common.PostDisconnectHook,
		c.SFTPD.KeyboardInteractiveHook, c.ProviderConf.Actions.Hook, c.ProviderConf.ExternalAuthHook,
		c.ProviderConf.PreLoginHook, c.ProviderConf.PostLoginHook, c.ProviderConf.CheckPasswordHook,
	}
	for _, hook := range hooks {
		if hook != "" {
			return fmt.Errorf("fdrive-local-v1 requires all executable and HTTP hooks disabled")
		}
	}
	if len(c.PluginsConfig) != 0 || len(c.Common.EventManager.EnabledCommands) != 0 {
		return fmt.Errorf("fdrive-local-v1 requires plugins and Event Manager commands disabled")
	}
	for _, command := range c.SFTPD.EnabledSSHCommands {
		switch command {
		case "scp", "md5sum", "sha1sum", "sha256sum", "sha384sum", "sha512sum", "cd", "pwd":
		default:
			return fmt.Errorf("fdrive-local-v1 does not support SSH command %q", command)
		}
	}
	if c.ProviderConf.IsShared != 0 {
		return fmt.Errorf("fdrive-local-v1 requires a single SFTPGo process")
	}
	return nil
}
